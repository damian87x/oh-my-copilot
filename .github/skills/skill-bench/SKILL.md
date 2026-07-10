---
name: skill-bench
description: Compare an omp skill against a bare model and a one-line prompt, then open an HTML report with quality, token, and cost evidence. Use with /skill-bench check, latest, code-review, tdd, or ralplan.
---

# Skill Bench

Run the packaged benchmark without exposing its Python implementation to the user.

## Modes

| argument | action | model calls |
|---|---|---|
| `check` | validate every deterministic scorer | none |
| `latest` | rescore and open the newest saved run | none |
| `code-review` | run task `code-review-sqli` | yes |
| `tdd` | run task `tdd-slugify` | yes |
| `ralplan` | run task `ralplan-pwreset` | yes |

With no argument or an unknown argument, print this mode list and stop. Never start a live run by
default. An explicit live mode is consent to run real benchmark cells.

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
