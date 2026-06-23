# Skill performance benchmark

Measures whether oh-my-copilot **skills** improve agent outcomes — and at what
token/latency cost — versus a clean **no-skills** baseline. Config-driven, with
deterministic scoring so it runs unattended.

## Quick start

```bash
# wire-check (no Copilot calls)
node tools/bench/bench-skills.mjs --dry-run

# real run, fast subset
node tools/bench/bench-skills.mjs --problems p01-debug-off-by-one,p06-tdd-fizzbuzz

# full suite (25 problems × 2 modes) — consumes model quota
node tools/bench/bench-skills.mjs
```

Requires the GitHub Copilot CLI (`copilot`) on PATH and a configured model.
Override the binary with `OMP_COPILOT_BIN`.

## What gets compared

| Mode | `skills` | Meaning |
| --- | --- | --- |
| `no-skills` | `false` | `.github/skills` + `~/.copilot/skills` temporarily parked so Copilot sees no skills. Restored after the mode (even on crash). |
| `with-skills` | `true` | Skills available as normal. |

Add more modes in `bench.config.json` — e.g. an `OMP_MINIFY=0` mode via `env`,
or a different model via a second config.

## Mechanics

Per `(problem × mode × run)` cell:

1. Copy `problems/<id>/fixture/` → isolated workdir; run `setup`.
2. `copilot --model <M> -p "<prompt>" --allow-all-tools` (headless), captured.
3. Score transcript + files against the problem's `checks`.
4. Record score, pass/fail, duration, approx out-tokens, tool-call count.

Artifacts: `.omp/state/bench/run-<timestamp>/` → `report.md`, `results.json`,
and `work/<cell>/transcript.log`.

## Files

- `bench-skills.mjs` — the runner.
- `bench.config.json` — config (model, runs, modes, timeout, artifact dir).
- `bench.schema.json` — JSON Schema for the config + problem format.
- `gen-problems.mjs` — regenerates the 25 starter problems.
- `problems/<id>/problem.json` (+ `fixture/`) — the test cases.

## Problem set (25)

Spread across the skills that *should* move the needle: debugging
(`p01,p02,p11,p14,p16,p20,p24`), noisy-log triage (`p04`), typecheck/verify
(`p03,p25`), research/read-only (`p05,p15,p19,p23`), TDD
(`p06,p12,p17,p21,p22`), code review (`p07,p10`), and scoped/no-overreach edits
(`p08,p09,p13,p18`). Each is graded by `shell_exit_zero`, `file_*`, or
`transcript_*` checks — no manual grading needed.

## CLI flags

`--config <path>` · `--problems <csv>` · `--modes <csv>` · `--runs <N>` ·
`--model <M>` · `--out <dir>` · `--dry-run`

## Caveats

- Run on disposable fixtures only (`--allow-all-tools` = full access).
- Token figures are `length/4` estimates of stdout, not provider-billed usage;
  report them as estimates and any percentage as workload-specific.
- Live results are workload-specific. `runsPerCell > 1` surfaces variance.
