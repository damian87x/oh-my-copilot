---
name: skill-bench
description: Compare an omp skill directly or use local Copilot history to choose one safely. Use with bare /skill-bench, /skill-bench 7d current, /skill-bench --since 30d --project all, check, latest, code-review, tdd, or ralplan.
---

# Skill Bench

Run the packaged benchmark without exposing its Python implementation to the user.

## Modes

| argument | action | nested benchmark cells |
|---|---|---|
| none or history filters | rank actual local skill history, then confirm one live choice | only after yes |
| `check` | validate every deterministic scorer | none |
| `latest` | rescore and open the newest saved run | none |
| `code-review` | run task `code-review-sqli` | yes |
| `tdd` | run task `tdd-slugify` | yes |
| `ralplan` | run task `ralplan-pwreset` | yes |

Any argument not matching a direct mode or the guided filters below is unknown; print this mode list
and stop. An explicit live mode is consent to run
real benchmark cells. The containing Copilot turn still uses the session model even when the
selected mode starts no nested benchmark cells.

Guided history mode accepts no arguments (default `30d all`), positional `7d|30d|90d|all` and
`current|all`, `--window`, the `--since` alias, and `--project`. Normalize the default to exactly
`omp history analyze --window 30d --project all --json`; normalize filtered input to exactly
`omp history analyze --window <window> --project <project> --json`. Run that command and require a
successful schema-version-1 history report before invoking `/grill-me`; an unavailable or unknown
history command must stop here. If the shell saves large output to a file, parse that exact JSON file;
that is not an analyzer failure. `check`, `latest`, and the three direct live modes bypass guided history.
Read ranked benchmarkable entries from the top-level `skills` array and observed unsupported entries
from the top-level `unsupportedSkills` array; do not guess alternate property names. `skills` entries
use exactly `skill`, `invocations`, `sessions`, `lastInvokedAt`, `benchmarkable`, and `benchmarkTask`.
Display only `code-review`, `tdd`, and `ralplan` as benchmarkable, preserving array order, and list
observed unsupported skills separately. Select the first ranked supported skill, which is the first
entry in `skills`. Call the `skill` tool with `skill: "grill-me"`. Do not call `ask_user` directly
before loading it. After loading `/grill-me`, ask exactly one question naming the selected supported
skill and requesting explicit affirmative confirmation to start live benchmark cells.
Only after an unambiguous affirmative answer may the existing mapped live-mode path run any
`python3 run.py --task` command.
On refusal, ambiguity, no supported history, analyzer failure, or unavailable `/grill-me`,
stop without starting live benchmark cells and print the direct modes plus the exact guided filters
`--since 7d|30d|90d|all` and `--project current|all`; never suggest arbitrary project names.
History rank alone is never consent.

## Resolve the benchmark

1. Require `omp` and `python3` on `PATH`.
2. Run `omp version --json`, parse its `packageRoot`, and use
   `<packageRoot>/benchmarks/skill-bench` as the benchmark directory.
3. Require `run.py` in that directory. Report the missing command or path directly and stop.

## Execute

- `check`: from the benchmark directory, run `python3 run.py --selftest`. Success must include
  `all instruments valid`.
- `latest`: find the newest directory under its `runs` subdirectory, then run
  `python3 run.py --rescore <run-directory>`. If none exists, say so and stop.
- Live modes: first run `python3 run.py --selftest` and stop if it fails. Then run:

```bash
python3 run.py --task <mapped-task> --arms baseline,skill,prompt \
  --models gpt-5-mini,claude-haiku-4.5 --runs 1 --workers 2
```

Do not silently change models, arms, repetitions, or workers. Preserve the runner output and take
the report path from its final `report:` line. Require the resulting `sweep_report.html` to exist.

## Present the result

Open `sweep_report.html` with the platform's normal HTML opener (`open` on macOS or `xdg-open` on
Linux). If no opener is available, print the absolute path instead.

Read the generated summary and report, then state:

- the winner and why it won (quality first, cost only as a tie-breaker),
- correct and applied percentages,
- USD and AI credits per successful run,
- input, cached-input, cache-write, output, and total tokens,
- any missing or unresolved pricing telemetry.

Do not call every 100% row a winner; apply the report's tie-break order. Do not claim a cost when
token or session telemetry is incomplete.
