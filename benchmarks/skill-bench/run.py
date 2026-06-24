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


def read_claude_meta(workdir):
    """Pull cost/turns/duration/tokens from a host CLI JSON dump if present."""
    for name in ("_cli.json", "_claude.json"):
        p = workdir / name
        if not p.exists():
            continue
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}, ""
        u = j.get("usage") or {}
        meta = {"cost": j.get("total_cost_usd"), "duration_ms": j.get("duration_ms"),
                "turns": j.get("num_turns"),
                "out_tokens": u.get("output_tokens"), "in_tokens": u.get("input_tokens")}
        return meta, j.get("result", "")
    return {}, ""


def score_workspace(task_id, arm, engine, workdir):
    task = TASKS[task_id]
    meta, result_text = read_claude_meta(workdir)
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
    try:
        with open(out_path, "wb") as so, open(err_path, "wb") as se:
            proc = subprocess.Popen(cmd, cwd=str(workdir), stdout=so, stderr=se)
            try:
                proc.wait(timeout=CELL_TIMEOUT)
            except subprocess.TimeoutExpired:
                _killtree(proc.pid)
                try:
                    proc.wait(timeout=15)
                except Exception:
                    pass
                se.write(f"\n[KILLED after {CELL_TIMEOUT}s timeout]".encode())
    except Exception as e:
        out_path.write_text(json.dumps({"error": str(e)[:300]}), encoding="utf-8")
    return score_workspace(task_id, arm, engine, workdir)


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


# --- selftest: good ref must score applied+correct; bad ref must be caught on its axis ---
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
            "applied_rate": round(sum(c["applied"] for c in cells) / n, 3),
            "correct_rate": round(sum(c["correct"] for c in cells) / n, 3),
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

    def _one(spec):
        tid, arm, r = spec
        ws = out_dir / f"{tid}__{arm}__{args.engine}__{r}"
        ws.mkdir(parents=True, exist_ok=True)
        return run_cell(tid, arm, args.engine, ws)

    print(f"running {total} cells via '{args.engine}', {args.workers} at a time", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(_one, s): s for s in cells}
        for fut in concurrent.futures.as_completed(futs):
            tid, arm, r = futs[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"task": tid, "arm": arm, "error": str(e)[:200]}
            results.append(res)
            done += 1
            print(f"  [{done}/{total}] {tid} / {arm} #{r}  "
                  f"applied={res.get('applied')} correct={res.get('correct')} "
                  f"cost=${res.get('cost')}", flush=True)
            (out_dir / "results.json").write_text(json.dumps(
                {"date": stamp, "engine": args.engine, "results": results}, indent=2), encoding="utf-8")

    rows = aggregate(results)
    (out_dir / "summary.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    print_table(rows)
    print(f"\nwrote {out_dir}/results.json + summary.json ({len(results)} cells)")


if __name__ == "__main__":
    main()
