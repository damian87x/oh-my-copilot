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
      gives the best quality per premium-request and per second (see references from the
      rightmodel workshop). Writes sweep_report.html alongside summary.json.

  python run.py --rescore runs/<stamp>
      Recompute metrics + report from kept workspaces. No API. Use after changing a scorer.

Host CLI: defaults to `copilot` (omp's real host -- skills are Copilot CLI plugins). Use
--engine claude to run against the `claude` CLI instead. The engine layer is intentionally
thin; if your copilot CLI flags differ, adjust build_cmd() -- it is the only host-specific code.

Cost currency: the Copilot CLI reports NO token counts or USD -- only premiumRequests and
sessionDurationMs. So on --engine copilot the sweep measures quality vs premium-requests and
vs seconds. Real token/$ numbers require --engine claude (which returns usage + total_cost_usd).
"""
import argparse, concurrent.futures, datetime, json, os, re, shutil, statistics, subprocess, sys, tempfile
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

CELL_TIMEOUT = 300                           # seconds per cell; a hung agent is force-killed
PROBE_TIMEOUT = 20                           # seconds for the per-model entitlement probe

# Added to every arm identically: we measure the artifact, not its execution.
NO_RUN = ("Write your output to the file named in the task. Do not start a dev server, install "
          "dependencies, run a database, or open a browser -- just produce the artifact and stop.")


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
    (premiumRequests / sessionDurationMs -- copilot reports no USD cost or token counts)."""
    result_text, meta = "", {}
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
        elif t == "result":
            u = o.get("usage") or {}
            meta = {"cost": None, "premium_requests": u.get("premiumRequests"),
                    "duration_ms": u.get("sessionDurationMs") or u.get("totalApiDurationMs"),
                    "exit_code": o.get("exitCode")}
    return meta, result_text


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
        return _meta_claude(raw) if engine == "claude" else _meta_copilot(raw)
    except Exception:
        return {}, ""


def score_workspace(task_id, arm, engine, workdir, model=DEFAULT_MODEL):
    task = TASKS[task_id]
    meta, result_text = read_meta(workdir, engine)
    # if the skill answers in chat (no file), fall back to the captured result text
    if task.get("reads") == "chat" or not (workdir / task["file"]).exists():
        if result_text:
            (workdir / "_result.txt").write_text(result_text, encoding="utf-8")
    sc = task["score"](workdir)
    sc = {"task": task_id, "skill": task["skill"], "arm": arm, "engine": engine,
          "model": model, **sc, **meta}
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


def run_cell(task_id, arm, engine, workdir, model=DEFAULT_MODEL):
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
    return score_workspace(task_id, arm, engine, workdir, model=model)


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
    sweep formulas to the Copilot cost currency: premium-requests and seconds (tokens/USD
    are unavailable on the copilot host). `*_per_success` fold quality and cost into one
    number; they are None when a cell group had zero successes (correct==1)."""
    groups = defaultdict(list)
    for r in results:
        groups[(r["task"], r["arm"], r.get("model", DEFAULT_MODEL))].append(r)
    rows = []
    for (t, a, m), cells in sorted(groups.items()):
        n = len(cells)
        passes = sum((c.get("correct") or 0) for c in cells)
        secs = [(c["duration_ms"] / 1000) if c.get("duration_ms") is not None else None for c in cells]
        prs = [c.get("premium_requests") for c in cells]
        costs = [c["cost"] for c in cells if c.get("cost") is not None]
        total_secs = sum(s for s in secs if s is not None)
        total_pr = sum(p for p in prs if p is not None)
        rows.append({
            "task": t, "skill": cells[0].get("skill"), "arm": a, "model": m, "n": n,
            # error/timed-out cells may lack these keys -- treat a missing score as a 0.
            "applied_rate": round(sum((c.get("applied") or 0) for c in cells) / n, 3),
            "correct_rate": round(passes / n, 3),
            "premium_reqs_per_task": round(_mean(prs), 3) if any(p is not None for p in prs) else None,
            "premium_reqs_per_success": round(total_pr / passes, 3) if (passes and any(p is not None for p in prs)) else None,
            "seconds_per_task": round(_mean(secs), 1) if any(s is not None for s in secs) else None,
            "seconds_per_success": round(total_secs / passes, 1) if passes else None,
            "p50_seconds": round(_median(secs), 1) if any(s is not None for s in secs) else None,
            # back-compat fields (kept so old readers / --engine claude still work):
            "cost_mean": round(statistics.mean(costs), 4) if costs else None,
            "time_s_mean": round(_mean(secs), 1) if any(s is not None for s in secs) else None,
        })
    return rows


def print_table(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["task"]].append(r)
    for task, rs in sorted(by.items()):
        multi = len({r["model"] for r in rs}) > 1
        print(f"\n=== {task}  (skill={rs[0]['skill']}, n={rs[0]['n']}) ===")
        hdr = f"  {'arm':10} {'model':22} {'applied%':>9} {'correct%':>9} {'pr/task':>8} {'pr/win':>7} {'s/task':>7} {'s/win':>7}"
        print(hdr)
        for r in sorted(rs, key=lambda x: (x["arm"], x["model"])):
            def fmt(v, nd=2):
                return "-" if v is None else format(v, f".{nd}f")
            print(f"  {r['arm']:10} {(r['model'] if multi else '-'):22} "
                  f"{r['applied_rate']:>9} {r['correct_rate']:>9} "
                  f"{fmt(r['premium_reqs_per_task']):>8} {fmt(r['premium_reqs_per_success']):>7} "
                  f"{fmt(r['seconds_per_task'],1):>7} {fmt(r['seconds_per_success'],1):>7}")


def rescore(run_dir):
    run_dir = Path(run_dir)
    if not run_dir.exists():
        run_dir = RUNS_DIR / run_dir.name
    results = []
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
        results.append(score_workspace(tid, arm, engine, ws, model=model))
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
                results.append(score_workspace(tid, arm, args.engine, out_dir / name, model=model))
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
        res = run_cell(tid, arm, args.engine, ws, model=model)
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
                print(f"  [{done}/{total}] {tid} / {arm} / {model} #{r}  "
                      f"applied={res.get('applied')} correct={res.get('correct')} "
                      f"pr={res.get('premium_requests')} cost=${res.get('cost')}", flush=True)
                (out_dir / "results.json").write_text(json.dumps(
                    {"date": stamp, "engine": args.engine, "results": results}, indent=2),
                    encoding="utf-8")
    finally:
        shutil.rmtree(exec_root, ignore_errors=True)

    rows = aggregate(results)
    (out_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    report_mod.write_report(rows, results, out_dir)
    print_table(rows)
    print(f"\nwrote {out_dir}/results.json + summary.json ({len(results)} cells)")
    print(f"report: {out_dir / 'sweep_report.html'}")


if __name__ == "__main__":
    main()
