---
name: bench-skills
description: Benchmark skill performance — run N problems with skills enabled vs a clean no-skills baseline and report pass rate, score, tokens, and latency. Use with /bench-skills to prove whether skills actually improve outcomes.
argument-hint: "[--problems p01,p06] [--modes no-skills,with-skills] [--runs N] [--dry-run]"
---

# Bench Skills

Use `/bench-skills` to measure whether the oh-my-copilot skills actually improve
agent outcomes, and at what token/latency cost, vs a clean no-skills baseline.

It runs a configurable problem set (25 starter problems shipped) across one or
more **modes**, scores each run with **deterministic checks**, and writes a
JSON + Markdown report.

## When to use

- You changed a skill and want evidence it still helps (or regressed).
- You want an honest "skills on vs skills off" comparison on real tasks.
- You're deciding whether a skill earns its context cost.

## How it works

For each `(problem × mode × run)` cell the harness:

1. Copies the problem's `fixture/` into an isolated workdir and runs its `setup`.
2. Spawns Copilot headlessly: `copilot --model <M> -p "<prompt>" --allow-all-tools`.
3. For `skills: false` modes, the `.github/skills` and `~/.copilot/skills` dirs are
   temporarily parked so Copilot discovers **no** skills, then restored (always,
   even on crash).
4. Scores the transcript + resulting files against the problem's `checks`.
5. Records score, pass/fail, duration, approx tokens, and tool-call count.

## Run it

```bash
# full suite, both modes (needs the Copilot CLI + a model; consumes quota)
node tools/bench/bench-skills.mjs

# fast subset
node tools/bench/bench-skills.mjs --problems p01-debug-off-by-one,p06-tdd-fizzbuzz

# only the baseline, 3 runs each to see variance
node tools/bench/bench-skills.mjs --modes no-skills --runs 3

# wire-check without calling Copilot
node tools/bench/bench-skills.mjs --dry-run
```

Output lands in `.omp/state/bench/run-<timestamp>/`:
- `report.md` — aggregate-by-mode table, two-mode delta, per-problem breakdown.
- `results.json` — every cell with full check detail.
- `work/<cell>/transcript.log` — raw Copilot output per cell.

## Configure

Edit `tools/bench/bench.config.json` (schema: `bench.schema.json`):
- `model`, `runsPerCell`, `timeoutMs`, `allowAllTools`, `concurrency`.
- `modes[]` — add modes with `env` overrides (e.g. `{"OMP_MINIFY":"0"}`) or
  `extraArgs`. `skills: false` = baseline.
- Problems load from `problems/<id>/problem.json` (or inline in `problems[]`).

## Add a problem

Create `tools/bench/problems/<id>/problem.json`:

```json
{
  "id": "p26-my-case", "title": "...", "tags": ["debug"], "weight": 1,
  "prompt": "Exact prompt sent to copilot -p",
  "setup": "optional shell run in workdir first",
  "checks": [
    { "type": "shell_exit_zero", "value": "node -e \"...\"", "label": "behaves correctly" },
    { "type": "file_contains", "path": "x.js", "value": "needle", "label": "edited x.js" },
    { "type": "transcript_regex", "value": "PASS|FAIL", "label": "gave a verdict" }
  ]
}
```

Put any starting files in `problems/<id>/fixture/`. Check types:
`transcript_contains` / `_not_contains` / `_regex`, `file_exists`,
`file_contains`, `shell_exit_zero`, `exit_zero`, `max_tool_calls`.

## Rules

- Run only on disposable fixtures — `--allow-all-tools` gives full access.
- Token counts are `length/4` estimates of captured stdout, **not** billed usage.
  Label them as estimates and percentages as workload-specific.
- Keep `concurrency: 1` unless you know your rate/quota limits.
- A good benchmark needs problems where skills *should* matter (planning,
  scoped edits, noisy-log debugging) — not just trivial one-liners.
