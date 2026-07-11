#!/usr/bin/env python3
"""Agentic skill benchmark for oh-my-copilot (omp), with an optional model sweep.

Adapted from DietrichGebert/ponytail's agentic harness (MIT). Each cell is a REAL headless
CLI session in an isolated temp workspace seeded with a starter file, scored deterministically
on whether the SKILL'S PRESCRIBED BEHAVIOUR showed up (tests written / bug caught / plan emitted)
and whether the artifact is sound.

Arms:
  baseline   -- no skill (the fair baseline: the real agent doing the job with no guidance)
  skill      -- the omp skill under test, activated as a plugin
  prompt     -- a one-line plain-English instruction matching the skill's intent
                (the "does the skill beat just telling the model to do it?" control)

  python run.py --selftest
      Verify every scorer (good passes, bad is caught). NO API, NO spend. Run first, always.

  python run.py --all --runs 3
      Live run (spends API/usage). Workspaces kept under runs/<stamp>/ for inspection.

  python run.py --all --models gpt-5-mini,claude-haiku-4.5 --runs 3
      MODEL SWEEP: run the same tasks x arms across each --model slug, then report which model
      gives the best quality/process result, using USD, premium requests, and time as tie-breaks.
      Writes sweep_report.html alongside summary.json.

  python run.py --rescore runs/<stamp>
      Recompute metrics + report from kept workspaces. No model call/spend; an old run without a
      pricing snapshot may make one public GitHub Docs request. Use after changing a scorer.

Host CLI: defaults to `copilot` (omp's real host -- skills are Copilot CLI plugins). Use
--engine claude to run against the `claude` CLI instead. The engine layer is intentionally
thin; if your copilot CLI flags differ, adjust build_cmd() -- it is the only host-specific code.

Cost currency: Copilot cells read the completed session's full input/cache/output token breakdown
and reported AI-credit total. The run snapshots GitHub's official model-pricing table so the
reported total can be checked and older sessions can be estimated when direct cost telemetry is
missing. Legacy premium requests remain a separate metric. The --engine claude path records usage
and total_cost_usd when the host returns them.
"""
import argparse, concurrent.futures, datetime, json, os, re, shutil, statistics, subprocess, sys, tempfile, urllib.request
from collections import defaultdict
from pathlib import Path

from tasks import TASKS
import report as report_mod

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]                       # repo root (oh-my-copilot/)
RUNS_DIR = HERE / "runs"
SKILLS_DIR = ROOT / ".github" / "skills"

# Plain-prompt control arm text, per skill. Deliberately short -- the "just tell it" baseline.
PROMPT_ARM = {
    "tdd": "Use test-driven development: write a failing test first, then the implementation.",
    "code-review": "Do a thorough code review. Flag any security or correctness blockers and give a verdict.",
    "ralplan": "Write an implementation plan first with steps, acceptance criteria, tests and risks. Do not implement yet.",
    "debug": "Debug systematically: reproduce, identify the root cause, fix it, and add a regression test.",
}

# Default Copilot `--model` slugs to sweep. Mirrors a subset of KNOWN_MODEL_SLUGS in
# src/copilot/models.ts (copilot has no model-listing API, so this is hand-maintained).
# Small on purpose -- one per family across the cost range; override with --models a,b,c.
DEFAULT_MODELS = ["gpt-5-mini", "claude-haiku-4.5", "claude-sonnet-4.6", "gemini-3.5-flash"]

# Sentinel used in cell names when no explicit model is pinned (single-model / host default).
DEFAULT_MODEL = "default"

# A model slug becomes a filesystem path component and part of the `__`-delimited cell name,
# so it must not contain a path separator or the delimiter. (Copilot slugs are dot/hyphen only.)
SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9._-]+$")

CELL_TIMEOUT = 300                           # seconds per cell; a hung agent is force-killed
PROBE_TIMEOUT = 20                           # seconds for the per-model entitlement probe
PRICING_PAGE_URL = "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing"
PRICING_API_URL = ("https://docs.github.com/api/article/body?pathname="
                   "/en/copilot/reference/copilot-billing/models-and-pricing")
AI_CREDIT_USD = 0.01

# Added to every arm identically: we measure the artifact, not its execution.
NO_RUN = ("Write your output to the file named in the task. Do not start a dev server, install "
          "dependencies, run a database, or open a browser -- just produce the artifact and stop.")


def _pricing_model_slug(display_name):
    """Convert GitHub's pricing-table display name to the CLI's model slug shape."""
    name = re.sub(r"\[\^[^]]+\]", "", display_name).lower()
    return re.sub(r"[^a-z0-9.]+", "-", name).strip("-")


def _price(cell):
    value = cell.strip().removeprefix("$").replace(",", "")
    try:
        return float(value)
    except ValueError:
        return None


def parse_pricing_markdown(markdown):
    """Parse GitHub Docs' model-pricing Markdown into rates keyed by CLI model slug."""
    rates = defaultdict(list)
    provider, headers = None, None
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if line.startswith("### "):
            provider, headers = line[4:].strip(), None
            continue
        if not provider or not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if cells and cells[0].lower() == "model":
            headers = [header.lower() for header in cells]
            continue
        if not headers or len(cells) != len(headers) or not cells[0]:
            continue
        if all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        row = dict(zip(headers, cells))
        model = row.get("model", "")
        rates[_pricing_model_slug(model)].append({
            "display_name": model,
            "provider": provider,
            "tier": row.get("tier"),
            "threshold": row.get("threshold (input tokens)"),
            "input_usd_per_million": _price(row.get("input", "")),
            "cached_input_usd_per_million": _price(row.get("cached input", "")),
            "cache_write_usd_per_million": _price(row.get("cache write", "")),
            "output_usd_per_million": _price(row.get("output", "")),
        })
    return dict(rates)


def _fetch_text(url):
    with urllib.request.urlopen(url, timeout=15) as response:
        return response.read().decode("utf-8")


def load_or_fetch_pricing(run_dir, fetch_text=None):
    """Load a run's immutable pricing snapshot, or fetch it once from GitHub Docs."""
    path = Path(run_dir) / "pricing.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    try:
        markdown = (fetch_text or _fetch_text)(PRICING_API_URL)
        rates = parse_pricing_markdown(markdown)
        if not rates:
            raise ValueError("pricing page contained no model rows")
        snapshot = {
            "source_url": PRICING_PAGE_URL,
            "api_url": PRICING_API_URL,
            "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "rates": rates,
        }
        path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        return snapshot
    except Exception as exc:
        print(f"warning: GitHub Copilot pricing unavailable ({str(exc)[:160]}); "
              "USD/AI-credit estimates will be blank", file=sys.stderr)
        return None


def price_usage(usage, model, pricing):
    """Return authoritative session cost, with GitHub's website rates as a fallback/check."""
    website_cost = None
    rows = (pricing or {}).get("rates", {}).get(model, [])
    website_status = "unresolved_tiered_pricing" if len(rows) > 1 else None
    # Aggregate session telemetry cannot safely choose between default/long-context tiers.
    if len(rows) == 1:
        rate = rows[0]
        token_keys = ("input_tokens", "cached_input_tokens", "cache_write_tokens", "out_tokens")
        required_rates = ("input_usd_per_million", "cached_input_usd_per_million",
                          "output_usd_per_million")
        complete_usage = all(isinstance(usage.get(key), (int, float)) for key in token_keys)
        complete_rates = all(isinstance(rate.get(key), (int, float))
                             for key in required_rates)
        cache_write_rate = rate.get("cache_write_usd_per_million")
        cache_write_supported = (not usage.get("cache_write_tokens")
                                 or isinstance(cache_write_rate, (int, float)))
        if complete_usage and complete_rates and cache_write_supported:
            website_cost = (
                usage["input_tokens"] * rate["input_usd_per_million"]
                + usage["cached_input_tokens"] * rate["cached_input_usd_per_million"]
                + usage["cache_write_tokens"] * (cache_write_rate or 0)
                + usage["out_tokens"] * rate["output_usd_per_million"]
            ) / 1_000_000

    reported_nano_aiu = usage.get("reported_nano_aiu")
    if isinstance(reported_nano_aiu, (int, float)) and reported_nano_aiu >= 0:
        ai_credits = reported_nano_aiu / 1_000_000_000
        result = {
            "cost_usd": ai_credits * AI_CREDIT_USD,
            "ai_credits": ai_credits,
            "cost_source": "copilot_session",
        }
        if website_cost is not None:
            result["website_cost_usd"] = website_cost
            result["website_cost_delta_usd"] = result["cost_usd"] - website_cost
        elif website_status:
            result["website_cost_status"] = website_status
        return result
    if website_cost is None:
        return {"website_cost_status": website_status} if website_status else {}
    return {
        "cost_usd": website_cost,
        "ai_credits": website_cost / AI_CREDIT_USD,
        "cost_source": (pricing or {}).get("source_url", PRICING_PAGE_URL),
    }


def skill_text(skill):
    """Read the SKILL.md body for the skill-under-test (used by the --engine claude path,
    which injects the skill via --append-system-prompt rather than plugin activation)."""
    p = SKILLS_DIR / skill / "SKILL.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def build_cmd(engine, task, arm, workdir, model=None):
    """Return the CLI argv for one cell. THE ONLY host-specific code -- adjust flags here
    if your local copilot/claude CLI version differs.

    arm:   'baseline' | 'skill' | 'prompt'
    model: a host `--model` slug, or None/DEFAULT_MODEL to use the CLI's default model.
    """
    skill = task["skill"]
    prompt = task["prompt"] + "\n\n" + NO_RUN
    pinned = model and model != DEFAULT_MODEL

    if engine == "claude":
        claude = shutil.which("claude")
        if not claude:
            sys.exit("claude CLI not found on PATH (or use --engine copilot)")
        append = NO_RUN
        if arm == "skill":
            append = skill_text(skill) + "\n\n" + NO_RUN
        elif arm == "prompt":
            append = PROMPT_ARM[skill] + "\n\n" + NO_RUN
        cmd = [claude, "-p", task["prompt"], "--permission-mode", "bypassPermissions",
               "--output-format", "json", "--setting-sources", "project,local",
               "--strict-mcp-config", "--append-system-prompt", append]
        if pinned:
            cmd += ["--model", model]
        return cmd

    # default engine: copilot (omp's real host). Skills are installed as a Copilot plugin
    # (`copilot plugin install oh-my-copilot@oh-my-copilot`) and invoked via slash command.
    copilot = shutil.which("copilot")
    if not copilot:
        sys.exit("copilot CLI not found on PATH (install it, or use --engine claude)")
    if arm == "skill":
        # invoke the skill's slash command so the plugin activates for this turn
        user = f"/{skill} {prompt}"
    elif arm == "prompt":
        user = PROMPT_ARM[skill] + "\n\n" + prompt
    else:
        user = prompt
    # NOTE: copilot CLI non-interactive flags vary by version. This uses the common
    # `-p/--prompt` one-shot form with JSON output. Adjust if your version differs.
    cmd = [copilot, "-p", user, "--allow-all-tools", "--output-format", "json"]
    if pinned:
        cmd += ["--model", model]
    return cmd


def probe_model(engine, model):
    """Classify `--model <model>` on this host as available | unavailable | unknown. Mirrors
    probeModel() in src/copilot/models.ts: a working model is proven by captured stdout
    (copilot -p often hangs after answering); the entitlement signature on stderr proves it is
    unavailable; anything else (timeout/crash with no output) is UNKNOWN -- 'slow/broken' is not
    the same as 'not entitled', so we do not drop it. Returns (status, why)."""
    bin_name = "claude" if engine == "claude" else "copilot"
    exe = shutil.which(bin_name)
    if not exe:
        sys.exit(f"{bin_name} CLI not found on PATH")
    cmd = [exe, "-p", "Reply with: ok", "--model", model]
    if engine == "copilot":
        cmd += ["--allow-all-tools"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=PROBE_TIMEOUT)
        out, err, code = p.stdout or "", p.stderr or "", p.returncode
    except subprocess.TimeoutExpired as e:
        out = (e.stdout.decode() if isinstance(e.stdout, bytes) else e.stdout) or ""
        err, code = "", None
    low = err.lower()
    if any(s in low for s in ("does not have access", "not entitled", "no access", "not available", "invalid model")):
        return "unavailable", "not entitled"
    if out.strip() or code == 0:
        return "available", "ok"
    return "unknown", "no output (timeout/crash) -- kept unverified; --no-probe to skip probing"


def filter_available_models(engine, models):
    """Probe each candidate once and drop ONLY the provably-unavailable ones, LOUDLY (never a
    silent cap; an 'unknown' probe is kept, matching src/copilot/models.ts). Returns the kept
    list; exits if nothing survives."""
    kept, dropped = [], []
    print(f"probing {len(models)} model(s) on '{engine}' for entitlement...", flush=True)
    for m in models:
        if m == DEFAULT_MODEL:
            kept.append(m)
            print(f"  - {m:22} kept (host default, not probed)", flush=True)
            continue
        status, why = probe_model(engine, m)
        label = {"available": "AVAILABLE", "unknown": "KEPT     ", "unavailable": "SKIPPED  "}[status]
        print(f"  - {m:22} {label} ({why})", flush=True)
        (dropped if status == "unavailable" else kept).append(m)
    if not kept:
        sys.exit("no requested models are available on this host; nothing to run")
    if dropped:
        print(f"note: running {len(kept)}/{len(models)} requested models "
              f"(skipped as unavailable: {', '.join(dropped)})", flush=True)
    return kept


def seed_workspace(task, workdir, ref_kind=None, for_selftest=False):
    """Write the task's seed files. For selftest, overwrite the entry file with the good/bad
    reference and (for the good case of a test-requiring skill) any good_extra siblings."""
    for fn, content in task.get("seed", {}).items():
        (workdir / fn).write_text(content, encoding="utf-8")
    if for_selftest and ref_kind:
        (workdir / task["file"]).write_text(task[ref_kind], encoding="utf-8")
        if ref_kind == "good":
            for fn, content in task.get("good_extra", {}).items():
                (workdir / fn).write_text(content, encoding="utf-8")


def _meta_claude(raw):
    """claude -p --output-format json emits ONE JSON object."""
    j = json.loads(raw)
    u = j.get("usage") or {}
    return ({"cost": j.get("total_cost_usd"), "duration_ms": j.get("duration_ms"),
             "turns": j.get("num_turns"),
             "out_tokens": u.get("output_tokens"), "in_tokens": u.get("input_tokens")},
            j.get("result", ""))


def _meta_copilot(raw):
    """copilot -p --output-format json emits an NDJSON EVENT STREAM. The final answer is the
    last `assistant.message`.data.content; usage/duration come from the `result` event
    (premiumRequests / sessionDurationMs). Assistant outputTokens are emitted on
    `assistant.message` events."""
    result_text, meta = "", {}
    out_tokens = 0
    saw_out_tokens = False
    for ln in raw.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        t, d = o.get("type"), (o.get("data") or {})
        if t == "assistant.message" and isinstance(d.get("content"), str):
            result_text = d["content"]
            if isinstance(d.get("outputTokens"), (int, float)):
                out_tokens += d["outputTokens"]
                saw_out_tokens = True
        elif t == "result":
            u = o.get("usage") or {}
            meta = {"cost": None, "premium_requests": u.get("premiumRequests"),
                    "duration_ms": u.get("sessionDurationMs") or u.get("totalApiDurationMs"),
                    "exit_code": o.get("exitCode"),
                    "session_id": o.get("sessionId")}
    if saw_out_tokens:
        meta["out_tokens"] = out_tokens
    return meta, result_text


def _session_usage(workdir, session_id):
    """Read and cache the completed Copilot session's billing token categories."""
    cache_path = Path(workdir) / "_usage.json"
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("session_id") == session_id:
                return {k: v for k, v in cached.items() if k != "session_id"}
        except Exception:
            pass
    if (not isinstance(session_id, str) or not SAFE_SESSION_ID.fullmatch(session_id)
            or ".." in session_id or not re.search(r"[A-Za-z0-9]", session_id)):
        return {}
    copilot_home = Path(os.environ.get("COPILOT_HOME") or (Path.home() / ".copilot"))
    events_path = copilot_home / "session-state" / session_id / "events.jsonl"
    if not events_path.exists():
        return {}
    shutdown = None
    try:
        with events_path.open(encoding="utf-8") as events:
            for line in events:
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                if event.get("type") == "session.shutdown":
                    shutdown = event.get("data") or {}
    except Exception:
        return {}
    if shutdown is None:
        return {}
    details = shutdown.get("tokenDetails") or {}

    def count(kind):
        value = (details.get(kind) or {}).get("tokenCount")
        return value if isinstance(value, (int, float)) else None

    usage = {
        "input_tokens": count("input"),
        "cached_input_tokens": count("cache_read"),
        "cache_write_tokens": count("cache_write"),
        "out_tokens": count("output"),
        "reported_nano_aiu": shutdown.get("totalNanoAiu"),
        "reported_model": shutdown.get("currentModel"),
        "models_used": sorted((shutdown.get("modelMetrics") or {}).keys()),
    }
    if not any(value is not None for value in usage.values()):
        return {}
    cache_path.write_text(json.dumps({"session_id": session_id, **usage}, indent=2),
                          encoding="utf-8")
    return usage


def read_meta(workdir, engine):
    """Pull result text + cost/duration/usage from the host CLI dump, parsed per engine
    (the two CLIs use completely different JSON shapes)."""
    p = workdir / "_cli.json"
    if not p.exists():
        p = workdir / "_claude.json"          # legacy name
        if not p.exists():
            return {}, ""
    try:
        raw = p.read_text(encoding="utf-8")
    except Exception:
        return {}, ""
    try:
        if engine == "claude":
            return _meta_claude(raw)
        meta, result_text = _meta_copilot(raw)
        if meta.get("session_id"):
            meta.update(_session_usage(workdir, meta["session_id"]))
        return meta, result_text
    except Exception:
        return {}, ""


def score_workspace(task_id, arm, engine, workdir, model=DEFAULT_MODEL, pricing=None):
    task = TASKS[task_id]
    meta, result_text = read_meta(workdir, engine)
    requested_model = model
    models_used = meta.get("models_used") or []
    if len(models_used) == 1:
        model = models_used[0]
    elif model == DEFAULT_MODEL and isinstance(meta.get("reported_model"), str):
        model = meta["reported_model"]
    if engine == "copilot":
        priced = price_usage(meta, model, None if len(models_used) > 1 else pricing)
        if len(models_used) > 1 and pricing:
            priced.setdefault("website_cost_status", "unresolved_multi_model_session")
        meta.update(priced)
    # if the skill answers in chat (no file), fall back to the captured result text
    if task.get("reads") == "chat" or not (workdir / task["file"]).exists():
        if result_text:
            (workdir / "_result.txt").write_text(result_text, encoding="utf-8")
    sc = task["score"](workdir)
    sc = {"task": task_id, "skill": task["skill"], "arm": arm, "engine": engine,
          "model": model, **sc, **meta}
    if model != requested_model:
        sc["requested_model"] = requested_model
    # Honesty gate, applied HERE (not only in run_cell) so --resume/--rescore cannot turn a
    # timed-out or failed-to-spawn cell into a pass just because it left a plausible artifact.
    # Reads the persisted _status.json; absent (old runs) => no gate, preserving back-compat.
    st = workdir / "_status.json"
    if st.exists():
        try:
            status = json.loads(st.read_text(encoding="utf-8"))
        except Exception:
            status = {}
        sc["returncode"] = status.get("returncode")
        sc["timed_out"] = int(bool(status.get("timed_out")))
        if status.get("spawn_error"):
            sc["error"] = status["spawn_error"]
        if status.get("timed_out") or status.get("spawn_error"):
            sc["applied"], sc["correct"] = 0, 0
            sc["reason"] = ("timed out" if status.get("timed_out") else "spawn error") + \
                "; forced applied=correct=0 (honesty gate)"
    return sc


def run_cell(task_id, arm, engine, workdir, model=DEFAULT_MODEL, pricing=None):
    task = TASKS[task_id]
    seed_workspace(task, workdir)
    cmd = build_cmd(engine, task, arm, workdir, model=model)
    out_path, err_path = workdir / "_cli.json", workdir / "_cli.stderr.txt"
    timed_out, returncode, spawn_error = False, None, None
    try:
        with open(out_path, "wb") as so, open(err_path, "wb") as se:
            proc = subprocess.Popen(cmd, cwd=str(workdir), stdout=so, stderr=se)
            try:
                returncode = proc.wait(timeout=CELL_TIMEOUT)
            except subprocess.TimeoutExpired:
                timed_out = True
                _killtree(proc.pid)
                try:
                    proc.wait(timeout=15)
                except Exception:
                    pass
                se.write(f"\n[KILLED after {CELL_TIMEOUT}s timeout]".encode())
    except Exception as e:
        spawn_error = str(e)[:300]
        out_path.write_text(json.dumps({"error": spawn_error}), encoding="utf-8")
    # Persist execution status BEFORE scoring so the honesty gate in score_workspace (also used
    # by --resume/--rescore) sees it. This is what makes a resumed/rescored run honest.
    (workdir / "_status.json").write_text(json.dumps(
        {"timed_out": int(timed_out), "returncode": returncode, "spawn_error": spawn_error}),
        encoding="utf-8")
    return score_workspace(task_id, arm, engine, workdir, model=model, pricing=pricing)


def _killtree(pid):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            subprocess.run(["pkill", "-TERM", "-P", str(pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            os.kill(pid, 9)
        except Exception:
            pass


# --- selftest: good ref scores applied+correct; bad ref is caught on its axis; every
#     adversarial (gameable-but-wrong) fixture is rejected (applied=0). Proves the scorer
#     discriminates real skill behaviour from keyword mimicry before any API spend. ---
def selftest():
    failures = 0
    for tid, task in TASKS.items():
        axis = task.get("axis", "applied")
        for kind in ("good", "bad"):
            with tempfile.TemporaryDirectory() as d:
                seed_workspace(task, Path(d), ref_kind=kind, for_selftest=True)
                r = task["score"](Path(d))
            if kind == "good":
                ok = r["applied"] == 1 and r["correct"] == 1
            else:
                ok = r[axis] == 0
            print(f"{'ok ' if ok else 'XX '} {tid:18} {kind:4} applied={r['applied']} "
                  f"correct={r['correct']} axis={axis}  {r['reason']}")
            failures += 0 if ok else 1
        for adv in task.get("adversarial", []):
            with tempfile.TemporaryDirectory() as d:
                seed_workspace(task, Path(d))            # real seeds...
                (Path(d) / task["file"]).write_text(adv["file"], encoding="utf-8")  # ...then the trap artifact
                for fn, content in adv.get("extra", {}).items():
                    (Path(d) / fn).write_text(content, encoding="utf-8")
                r = task["score"](Path(d))
            ok = r["applied"] == 0                       # a gameable fake must NOT count as applied
            print(f"{'ok ' if ok else 'XX '} {tid:18} adv  applied={r['applied']} "
                  f"correct={r['correct']} [{adv['name']}]  {r['reason']}")
            failures += 0 if ok else 1
    print(f"\nselftest: {'all instruments valid' if not failures else str(failures) + ' BROKEN'}")
    return failures


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def _median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def aggregate(results):
    """Aggregate cells into one row per (task, arm, model). Metrics adapt the rightmodel
    sweep formulas to full token usage, AI credits/USD, legacy premium requests, and seconds.
    `*_per_success` folds quality and cost into one number; values are None when a cell group
    had zero successes (correct==1)."""
    groups = defaultdict(list)
    for r in results:
        groups[(r["task"], r["arm"], r.get("model", DEFAULT_MODEL))].append(r)
    rows = []
    for (t, a, m), cells in sorted(groups.items()):
        n = len(cells)
        passes = sum((c.get("correct") or 0) for c in cells)
        secs = [(c["duration_ms"] / 1000) if c.get("duration_ms") is not None else None for c in cells]
        prs = [c.get("premium_requests") for c in cells]
        ins = [c.get("input_tokens") for c in cells]
        cached_ins = [c.get("cached_input_tokens") for c in cells]
        cache_writes = [c.get("cache_write_tokens") for c in cells]
        outs = [c.get("out_tokens") for c in cells]
        cost_values = [c.get("cost_usd", c.get("cost")) for c in cells]
        costs = [value for value in cost_values if value is not None]
        credits = [c.get("ai_credits") for c in cells]
        cost_sources = {c.get("cost_source") for c, value in zip(cells, cost_values)
                        if value is not None}
        complete_costs = len(costs) == n
        uniform_cost_source = len(cost_sources) <= 1
        comparable_costs = complete_costs and uniform_cost_source
        complete_credits = all(value is not None for value in credits)
        complete_secs = all(value is not None for value in secs)
        complete_prs = all(value is not None for value in prs)
        complete_ins = all(value is not None for value in ins)
        complete_cached_ins = all(value is not None for value in cached_ins)
        complete_cache_writes = all(value is not None for value in cache_writes)
        complete_outs = all(value is not None for value in outs)
        total_secs = sum(s for s in secs if s is not None)
        total_pr = sum(p for p in prs if p is not None)
        total_in = sum(value for value in ins if value is not None)
        total_cached_in = sum(value for value in cached_ins if value is not None)
        total_cache_write = sum(value for value in cache_writes if value is not None)
        total_out = sum(t for t in outs if t is not None)
        total_cost = sum(value for value in costs if value is not None)
        total_credits = sum(value for value in credits if value is not None)
        rows.append({
            "task": t, "skill": cells[0].get("skill"), "arm": a, "model": m, "n": n,
            # error/timed-out cells may lack these keys -- treat a missing score as a 0.
            "applied_rate": round(sum((c.get("applied") or 0) for c in cells) / n, 3),
            "correct_rate": round(passes / n, 3),
            "premium_reqs_per_task": round(_mean(prs), 3) if complete_prs else None,
            "premium_reqs_per_success": (round(total_pr / passes, 3)
                                         if passes and complete_prs else None),
            "input_tokens_per_task": round(_mean(ins), 1) if complete_ins else None,
            "input_tokens_per_success": (round(total_in / passes, 1)
                                         if passes and complete_ins else None),
            "cached_input_tokens_per_task": (round(_mean(cached_ins), 1)
                                             if complete_cached_ins else None),
            "cached_input_tokens_per_success": (round(total_cached_in / passes, 1)
                                                if passes and complete_cached_ins else None),
            "cache_write_tokens_per_task": (round(_mean(cache_writes), 1)
                                            if complete_cache_writes else None),
            "cache_write_tokens_per_success": (round(total_cache_write / passes, 1)
                                               if passes and complete_cache_writes else None),
            "out_tokens_per_task": round(_mean(outs), 1) if complete_outs else None,
            "out_tokens_per_success": (round(total_out / passes, 1)
                                       if passes and complete_outs else None),
            "cost_usd_per_task": round(_mean(costs), 8) if comparable_costs else None,
            "cost_usd_per_success": (round(total_cost / passes, 8)
                                     if passes and comparable_costs else None),
            "ai_credits_per_task": (round(_mean(credits), 6)
                                    if comparable_costs and complete_credits else None),
            "ai_credits_per_success": (round(total_credits / passes, 6)
                                       if passes and comparable_costs and complete_credits else None),
            "cost_basis": ("partial" if costs and not complete_costs
                           else "mixed" if complete_costs and not uniform_cost_source
                           else next(iter(cost_sources)) if cost_sources else None),
            "seconds_per_task": round(_mean(secs), 1) if complete_secs else None,
            "seconds_per_success": (round(total_secs / passes, 1)
                                    if passes and complete_secs else None),
            "p50_seconds": round(_median(secs), 1) if complete_secs else None,
            # back-compat fields (kept so old readers / --engine claude still work):
            "cost_mean": round(statistics.mean(costs), 4) if comparable_costs else None,
            "time_s_mean": round(_mean(secs), 1) if complete_secs else None,
        })
    return rows


def print_table(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["task"]].append(r)
    for task, rs in sorted(by.items()):
        print(f"\n=== {task}  (skill={rs[0]['skill']}, n={rs[0]['n']}) ===")
        hdr = (f"  {'arm':10} {'model':22} {'applied%':>9} {'correct%':>9} "
               f"{'USD/win':>12} {'AI/win':>8} {'in/task':>9} {'cache/task':>10} "
               f"{'write/task':>10} {'out/task':>9} {'pr/win':>7} {'s/win':>7}")
        print(hdr)
        for r in sorted(rs, key=lambda x: (x["arm"], x["model"])):
            def fmt(v, nd=2):
                return "-" if v is None else format(v, f".{nd}f")
            def fmt_int(v):
                return "-" if v is None else format(v, ".0f")
            def fmt_usd(v):
                return "-" if v is None else f"${v:.8f}"
            print(f"  {r['arm']:10} {r['model']:22} "
                  f"{r['applied_rate']:>9} {r['correct_rate']:>9} "
                  f"{fmt_usd(r.get('cost_usd_per_success')):>12} "
                  f"{fmt(r.get('ai_credits_per_success'),3):>8} "
                  f"{fmt_int(r.get('input_tokens_per_task')):>9} "
                  f"{fmt_int(r.get('cached_input_tokens_per_task')):>10} "
                  f"{fmt_int(r.get('cache_write_tokens_per_task')):>10} "
                  f"{fmt_int(r.get('out_tokens_per_task')):>9} "
                  f"{fmt(r.get('premium_reqs_per_success')):>7} "
                  f"{fmt(r.get('seconds_per_success'),1):>7}")


def rescore(run_dir):
    run_dir = Path(run_dir)
    if not run_dir.exists():
        run_dir = RUNS_DIR / run_dir.name
    cells = []
    for ws in sorted(p for p in run_dir.iterdir() if p.is_dir()):
        parts = ws.name.split("__")
        # 5-part sweep name: task__arm__engine__model__run ; 4-part legacy: task__arm__engine__run
        if len(parts) == 5 and parts[0] in TASKS:
            tid, arm, engine, model, _r = parts
        elif len(parts) == 4 and parts[0] in TASKS:
            tid, arm, engine, _r = parts
            model = DEFAULT_MODEL
        else:
            continue
        cells.append((tid, arm, engine, model, ws))
    pricing = (load_or_fetch_pricing(run_dir)
               if any(engine == "copilot" for _tid, _arm, engine, _model, _ws in cells)
               else None)
    results = [score_workspace(tid, arm, engine, ws, model=model, pricing=pricing)
               for tid, arm, engine, model, ws in cells]
    rows = aggregate(results)
    (run_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    report_mod.write_report(rows, results, run_dir)
    print_table(rows)
    print(f"\nrescored {len(results)} cells from {run_dir}")
    print(f"report: {run_dir / 'sweep_report.html'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--rescore", help="recompute metrics + report from a kept run dir (no API)")
    ap.add_argument("--task", help="single task id (comma list ok)")
    ap.add_argument("--all", action="store_true", help="all tasks")
    ap.add_argument("--arms", default="baseline,skill,prompt")
    ap.add_argument("--engine", default="copilot", choices=["copilot", "claude"])
    ap.add_argument("--models", help="comma list of --model slugs to sweep; "
                    "pass 'default' for the DEFAULT_MODELS grid; omit for the host default model")
    ap.add_argument("--no-probe", action="store_true", help="skip the per-model entitlement probe")
    ap.add_argument("--resume", help="reuse an existing run dir; skip cells already recorded there")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    if args.selftest:
        sys.exit(1 if selftest() else 0)
    if args.rescore:
        return rescore(args.rescore)
    if selftest():
        sys.exit("instruments broken; refusing to spend on the API")

    task_ids = (list(TASKS) if args.all
                else ([t.strip() for t in args.task.split(",")] if args.task else []))
    if not task_ids:
        sys.exit("give --task <id>, --all, or --rescore <dir>")
    arms = [a.strip() for a in args.arms.split(",")]

    # Model grid: none -> single host-default cell; 'default' -> DEFAULT_MODELS; else the list.
    if not args.models:
        models = [DEFAULT_MODEL]
    elif args.models.strip() == "default":
        models = list(DEFAULT_MODELS)
    else:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    # A slug becomes a path component and part of the `__`-delimited cell name -- reject
    # anything that could escape a directory or break rescore parsing.
    for m in models:
        if m != DEFAULT_MODEL and ("__" in m or not SAFE_MODEL.match(m)):
            sys.exit(f"invalid model slug {m!r}: letters/digits/dot/hyphen only, no '__' or path separators")
    sweeping = models != [DEFAULT_MODEL]
    if sweeping and not args.no_probe:
        models = filter_available_models(args.engine, models)

    if args.resume:
        out_dir = Path(args.resume)
        if not out_dir.exists():
            out_dir = RUNS_DIR / out_dir.name
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = out_dir.name
    else:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        out_dir = RUNS_DIR / stamp
        out_dir.mkdir(parents=True, exist_ok=True)

    pricing = load_or_fetch_pricing(out_dir) if args.engine == "copilot" else None

    cells = [(tid, arm, model, r)
             for tid in task_ids for arm in arms for model in models for r in range(args.runs)]

    # Resume: a cell is DONE only if its recorded workspace has a non-empty _cli.json (not just
    # an empty dir), so a crashed/half-finished cell re-runs instead of counting as complete.
    def cell_name(tid, arm, model, r):
        return f"{tid}__{arm}__{args.engine}__{model}__{r}"

    def already_done(name):
        f = out_dir / name / "_cli.json"
        return f.exists() and f.stat().st_size > 0

    pending = [c for c in cells if not (args.resume and already_done(cell_name(*c)))]
    skipped = len(cells) - len(pending)
    total = len(pending)
    results, done = [], 0

    # Re-load any already-scored cells so the report/aggregate covers the full grid on resume.
    if args.resume and skipped:
        for c in cells:
            name = cell_name(*c)
            if already_done(name):
                tid, arm, model, _r = c
                results.append(score_workspace(tid, arm, args.engine, out_dir / name,
                                               model=model, pricing=pricing))
        print(f"resume: {skipped} cell(s) already recorded, {total} to run", flush=True)

    # Cells execute in a temp root OUTSIDE the repo so a tool-enabled agent cannot read the
    # scorer / reference answer keys (tasks.py) and optimize to the metric. Only the seed
    # files live in the cell's cwd. Artifacts are copied back to runs/<stamp> for inspection.
    # (Filesystem-level isolation only; a stronger sandbox would containerize the cell.)
    exec_root = Path(tempfile.mkdtemp(prefix="skillbench-exec-"))

    def _one(spec):
        tid, arm, model, r = spec
        name = cell_name(tid, arm, model, r)
        ws = exec_root / name
        ws.mkdir(parents=True, exist_ok=True)
        res = run_cell(tid, arm, args.engine, ws, model=model, pricing=pricing)
        try:
            shutil.copytree(ws, out_dir / name, dirs_exist_ok=True)
        except Exception:
            pass
        return res

    grid = f"{len(task_ids)} task(s) x {len(arms)} arm(s) x {len(models)} model(s) x {args.runs} run(s)"
    print(f"running {total} cells via '{args.engine}' ({grid}), {args.workers} at a time "
          f"(exec root: {exec_root})", flush=True)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(_one, s): s for s in pending}
            for fut in concurrent.futures.as_completed(futs):
                tid, arm, model, r = futs[fut]
                try:
                    res = fut.result()
                except Exception as e:
                    res = {"task": tid, "arm": arm, "model": model, "applied": 0, "correct": 0,
                           "error": str(e)[:200]}
                results.append(res)
                done += 1
                cost = res.get("cost_usd", res.get("cost"))
                cost_text = "-" if cost is None else f"${cost:.8f}"
                print(f"  [{done}/{total}] {tid} / {arm} / {model} #{r}  "
                      f"applied={res.get('applied')} correct={res.get('correct')} "
                      f"pr={res.get('premium_requests')} cost={cost_text}", flush=True)
                (out_dir / "results.json").write_text(json.dumps(
                    {"date": stamp, "engine": args.engine, "results": results}, indent=2),
                    encoding="utf-8")
    finally:
        shutil.rmtree(exec_root, ignore_errors=True)

    # Persist the complete grid even when --resume has no pending cells. The writes in the
    # completion loop remain as crash-safe checkpoints while cells are still running.
    (out_dir / "results.json").write_text(json.dumps(
        {"date": stamp, "engine": args.engine, "results": results}, indent=2),
        encoding="utf-8")
    rows = aggregate(results)
    (out_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    report_mod.write_report(rows, results, out_dir)
    print_table(rows)
    print(f"\nwrote {out_dir}/results.json + summary.json ({len(results)} cells)")
    print(f"report: {out_dir / 'sweep_report.html'}")


if __name__ == "__main__":
    main()
