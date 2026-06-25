#!/usr/bin/env python3
"""Agentic skill benchmark for oh-my-copilot (omp).

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

  python run.py --rescore runs/<stamp>
      Recompute metrics from kept workspaces. No API. Use after changing a scorer.

Host CLI: defaults to `copilot` (omp's real host -- skills are Copilot CLI plugins). Use
--engine claude to run against the `claude` CLI instead. The engine layer is intentionally
thin; if your copilot CLI flags differ, adjust build_cmd() -- it is the only host-specific code.
"""
import argparse, concurrent.futures, datetime, json, os, shutil, statistics, subprocess, sys, tempfile
from collections import defaultdict
from pathlib import Path

from tasks import TASKS

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

CELL_TIMEOUT = 300                           # seconds per cell; a hung agent is force-killed

# Added to every arm identically: we measure the artifact, not its execution.
NO_RUN = ("Write your output to the file named in the task. Do not start a dev server, install "
          "dependencies, run a database, or open a browser -- just produce the artifact and stop.")


def skill_text(skill):
    """Read the SKILL.md body for the skill-under-test (used by the --engine claude path,
    which injects the skill via --append-system-prompt rather than plugin activation)."""
    p = SKILLS_DIR / skill / "SKILL.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def build_cmd(engine, task, arm, workdir):
    """Return the CLI argv for one cell. THE ONLY host-specific code -- adjust flags here
    if your local copilot/claude CLI version differs.

    arm: 'baseline' | 'skill' | 'prompt'
    """
    skill = task["skill"]
    prompt = task["prompt"] + "\n\n" + NO_RUN

    if engine == "claude":
        claude = shutil.which("claude")
        if not claude:
            sys.exit("claude CLI not found on PATH (or use --engine copilot)")
        append = NO_RUN
        if arm == "skill":
            append = skill_text(skill) + "\n\n" + NO_RUN
        elif arm == "prompt":
            append = PROMPT_ARM[skill] + "\n\n" + NO_RUN
        return [claude, "-p", task["prompt"], "--permission-mode", "bypassPermissions",
                "--output-format", "json", "--setting-sources", "project,local",
                "--strict-mcp-config", "--append-system-prompt", append]

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
    return [copilot, "-p", user, "--allow-all-tools", "--output-format", "json"]


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


def score_workspace(task_id, arm, engine, workdir):
    task = TASKS[task_id]
    meta, result_text = read_meta(workdir, engine)
    # if the skill answers in chat (no file), fall back to the captured result text
    if task.get("reads") == "chat" or not (workdir / task["file"]).exists():
        if result_text:
            (workdir / "_result.txt").write_text(result_text, encoding="utf-8")
    sc = task["score"](workdir)
    return {"task": task_id, "skill": task["skill"], "arm": arm, "engine": engine, **sc, **meta}


def run_cell(task_id, arm, engine, workdir):
    task = TASKS[task_id]
    seed_workspace(task, workdir)
    cmd = build_cmd(engine, task, arm, workdir)
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
    sc = score_workspace(task_id, arm, engine, workdir)
    sc["returncode"], sc["timed_out"] = returncode, int(timed_out)
    if spawn_error:
        sc["error"] = spawn_error
    # Honesty gate: a timed-out or failed-to-spawn cell cannot count as a success even if it
    # left a plausible-looking artifact behind (a half-finished file, or the seed itself).
    if timed_out or spawn_error:
        sc["applied"], sc["correct"] = 0, 0
        sc["reason"] = ("timed out" if timed_out else "spawn error") + "; forced applied=correct=0"
    return sc


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


def aggregate(results):
    groups = defaultdict(list)
    for r in results:
        groups[(r["task"], r["arm"])].append(r)
    rows = []
    for (t, a), cells in sorted(groups.items()):
        n = len(cells)
        costs = [c["cost"] for c in cells if c.get("cost") is not None]
        rows.append({
            "task": t, "skill": cells[0].get("skill"), "arm": a, "n": n,
            # error/timed-out cells may lack these keys -- treat a missing score as a 0.
            "applied_rate": round(sum((c.get("applied") or 0) for c in cells) / n, 3),
            "correct_rate": round(sum((c.get("correct") or 0) for c in cells) / n, 3),
            "cost_mean": round(statistics.mean(costs), 4) if costs else None,
            "time_s_mean": (round(statistics.mean([c["duration_ms"] / 1000 for c in cells
                            if c.get("duration_ms") is not None]), 1)
                            if any(c.get("duration_ms") is not None for c in cells) else None),
        })
    return rows


def print_table(rows):
    by = defaultdict(list)
    for r in rows:
        by[r["task"]].append(r)
    for task, rs in sorted(by.items()):
        print(f"\n=== {task}  (skill={rs[0]['skill']}, n={rs[0]['n']}) ===")
        print(f"  {'arm':10} {'applied%':>9} {'correct%':>9} {'$/run':>8} {'time_s':>7}")
        for r in sorted(rs, key=lambda x: x["arm"]):
            c = ("$" + format(r["cost_mean"], ".4f")) if r["cost_mean"] is not None else "-"
            t = r.get("time_s_mean")
            print(f"  {r['arm']:10} {r['applied_rate']:>9} {r['correct_rate']:>9} "
                  f"{c:>8} {(t if t is not None else '-'):>7}")


def rescore(run_dir):
    run_dir = Path(run_dir)
    if not run_dir.exists():
        run_dir = RUNS_DIR / run_dir.name
    results = []
    for ws in sorted(p for p in run_dir.iterdir() if p.is_dir()):
        parts = ws.name.split("__")
        if len(parts) != 4 or parts[0] not in TASKS:
            continue
        tid, arm, engine, _r = parts
        results.append(score_workspace(tid, arm, engine, ws))
    rows = aggregate(results)
    (run_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print_table(rows)
    print(f"\nrescored {len(results)} cells from {run_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--rescore", help="recompute metrics from a kept run dir (no API)")
    ap.add_argument("--task", help="single task id (comma list ok)")
    ap.add_argument("--all", action="store_true", help="all tasks")
    ap.add_argument("--arms", default="baseline,skill,prompt")
    ap.add_argument("--engine", default="copilot", choices=["copilot", "claude"])
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
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = RUNS_DIR / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    cells = [(tid, arm, r) for tid in task_ids for arm in arms for r in range(args.runs)]
    total = len(cells)
    results, done = [], 0

    # Cells execute in a temp root OUTSIDE the repo so a tool-enabled agent cannot read the
    # scorer / reference answer keys (tasks.py) and optimize to the metric. Only the seed
    # files live in the cell's cwd. Artifacts are copied back to runs/<stamp> for inspection.
    # (Filesystem-level isolation only; a stronger sandbox would containerize the cell.)
    exec_root = Path(tempfile.mkdtemp(prefix="skillbench-exec-"))

    def _one(spec):
        tid, arm, r = spec
        name = f"{tid}__{arm}__{args.engine}__{r}"
        ws = exec_root / name
        ws.mkdir(parents=True, exist_ok=True)
        res = run_cell(tid, arm, args.engine, ws)
        try:
            shutil.copytree(ws, out_dir / name, dirs_exist_ok=True)
        except Exception:
            pass
        return res

    print(f"running {total} cells via '{args.engine}', {args.workers} at a time "
          f"(exec root: {exec_root})", flush=True)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
            futs = {ex.submit(_one, s): s for s in cells}
            for fut in concurrent.futures.as_completed(futs):
                tid, arm, r = futs[fut]
                try:
                    res = fut.result()
                except Exception as e:
                    res = {"task": tid, "arm": arm, "applied": 0, "correct": 0, "error": str(e)[:200]}
                results.append(res)
                done += 1
                print(f"  [{done}/{total}] {tid} / {arm} #{r}  "
                      f"applied={res.get('applied')} correct={res.get('correct')} "
                      f"cost=${res.get('cost')}", flush=True)
                (out_dir / "results.json").write_text(json.dumps(
                    {"date": stamp, "engine": args.engine, "results": results}, indent=2),
                    encoding="utf-8")
    finally:
        shutil.rmtree(exec_root, ignore_errors=True)

    rows = aggregate(results)
    (out_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print_table(rows)
    print(f"\nwrote {out_dir}/results.json + summary.json ({len(results)} cells)")


if __name__ == "__main__":
    main()
