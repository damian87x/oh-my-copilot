#!/usr/bin/env python3
"""LLM-judge pass for axes that resist a deterministic check.

The deterministic scorer in tasks.py answers "did the skill's behaviour show up and is the
artifact sound". It cannot grade soft quality -- e.g. is a ralplan plan actually GOOD, is a
code review's reasoning sound. That gets an LLM judge, made auditable the ponytail way:
a fixed model at temperature 0, a published rubric, and a selftest that must rank a known-good
artifact strictly above a known-bad one before we trust it on real submissions.

  python judge.py --selftest          # validate the judge on reference pairs (small spend)
  python judge.py --run runs/<stamp>   # judge every workspace in a matrix run

Key: ANTHROPIC_API_KEY from ../../.env or the environment. stdlib urllib, no deps.
"""
import argparse, json, os, re, sys, time, urllib.request
from collections import defaultdict
from pathlib import Path

from tasks import TASKS

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RUNS_DIR = HERE / "runs"
JUDGE_MODEL = "claude-sonnet-4-6"

RUBRIC = (
    "You are a senior engineer grading the QUALITY of an artifact produced for a task. "
    "Grade only how well the artifact does the job asked, on a 0-3 scale:\n"
    "0 = absent or useless\n"
    "1 = present but shallow / misses important parts\n"
    "2 = solid, covers the essentials\n"
    "3 = excellent, thorough and actionable\n"
    "For a PLAN: reward ordered slices, concrete acceptance criteria, a test shape, and named "
    "risks. For a REVIEW: reward catching real blockers with specific fixes and a clear verdict. "
    "Name the single biggest gap, or \"none\". "
    "Respond with ONLY this JSON: {\"quality\": <0-3 int>, \"why\": \"<one line>\", \"gap\": \"<gap or none>\"}"
)


def load_key():
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("ANTHROPIC_API_KEY=") and len(line) > 18:
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return os.environ.get("ANTHROPIC_API_KEY")


def artifact_text(workdir, task):
    """Read the artifact the agent produced for this task (the named file, or chat fallback)."""
    p = Path(workdir) / task["file"]
    if p.exists():
        return p.read_text(encoding="utf-8", errors="ignore")
    r = Path(workdir) / "_result.txt"
    return r.read_text(encoding="utf-8", errors="ignore") if r.exists() else ""


def judge_call(task_prompt, artifact, key, retries=3):
    user = f"TASK:\n{task_prompt}\n\nARTIFACT PRODUCED:\n{artifact}"
    body = json.dumps({"model": JUDGE_MODEL, "max_tokens": 300, "temperature": 0,
                       "system": RUBRIC, "messages": [{"role": "user", "content": user}]}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body,
                headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read())
            return j["content"][0]["text"]
        except Exception as e:
            if attempt == retries - 1:
                return f'{{"error": "{str(e)[:120]}"}}'
            time.sleep(2 * (attempt + 1))


def parse_score(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        if "quality" in d:
            d["quality"] = int(d["quality"])
        return d
    except Exception:
        return None


# selftest pairs: the judge must rank good > bad for the same task
SELFTEST_PAIRS = [
    ("ralplan-pwreset", "good", TASKS["ralplan-pwreset"]["good"]),
    ("ralplan-pwreset", "bad", TASKS["ralplan-pwreset"]["bad"]),
    ("code-review-sqli", "good", TASKS["code-review-sqli"]["good"]),
    ("code-review-sqli", "bad", TASKS["code-review-sqli"]["bad"]),
]


def selftest(key):
    scores = {}
    for tid, label, art in SELFTEST_PAIRS:
        s = parse_score(judge_call(TASKS[tid]["prompt"], art, key))
        scores[(tid, label)] = s
        print(f"  {tid:18} {label:5} -> {s}")
    ok = True
    for tid in ("ralplan-pwreset", "code-review-sqli"):
        hi = scores.get((tid, "good"), {}) or {}
        lo = scores.get((tid, "bad"), {}) or {}
        if not (isinstance(hi.get("quality"), int) and isinstance(lo.get("quality"), int)
                and hi["quality"] > lo["quality"]):
            print(f"XX {tid}: judge did not rank good above bad")
            ok = False
        else:
            print(f"ok {tid}: good({hi['quality']}) > bad({lo['quality']})")
    print(f"\njudge selftest: {'valid' if ok else 'NOT TRUSTWORTHY'}")
    return 0 if ok else 1


def run(run_dir, key):
    run_dir = Path(run_dir)
    if not run_dir.exists():
        run_dir = RUNS_DIR / run_dir.name
    cells, scored = [], []
    for ws in sorted(p for p in run_dir.iterdir() if p.is_dir()):
        parts = ws.name.split("__")
        if len(parts) != 4 or parts[0] not in TASKS:
            continue
        cells.append((parts[0], parts[1], ws))
    print(f"judging {len(cells)} workspaces with {JUDGE_MODEL} ...")
    for i, (tid, arm, ws) in enumerate(cells, 1):
        art = artifact_text(ws, TASKS[tid])
        s = parse_score(judge_call(TASKS[tid]["prompt"], art, key)) or {"quality": None}
        scored.append({"task": tid, "arm": arm, "quality": s.get("quality"),
                       "why": s.get("why", ""), "gap": s.get("gap", "")})
        if i % 10 == 0 or i == len(cells):
            print(f"  [{i}/{len(cells)}]", flush=True)
        (run_dir / "judge.json").write_text(json.dumps(
            {"judge": JUDGE_MODEL, "rubric": RUBRIC, "scores": scored}, indent=2), encoding="utf-8")
    by_arm = defaultdict(list)
    for r in scored:
        if isinstance(r["quality"], int):
            by_arm[r["arm"]].append(r["quality"])
    print(f"\n=== quality by arm (judge: {JUDGE_MODEL}, 0=useless .. 3=excellent) ===")
    print(f"  {'arm':10} {'n':>4} {'mean':>6} {'min':>4}")
    for arm in ("baseline", "prompt", "skill"):
        v = by_arm.get(arm, [])
        if v:
            print(f"  {arm:10} {len(v):>4} {sum(v) / len(v):>6.2f} {min(v):>4}")
    print(f"\nwrote {run_dir / 'judge.json'}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--run", help="run dir to judge")
    args = ap.parse_args()
    key = load_key()
    if not key:
        sys.exit("no ANTHROPIC_API_KEY (.env or env)")
    if args.selftest:
        sys.exit(selftest(key))
    if args.run:
        if selftest(key):
            sys.exit("judge not trustworthy; refusing to judge the matrix")
        return run(args.run, key)
    sys.exit("give --selftest or --run <dir>")


if __name__ == "__main__":
    main()
