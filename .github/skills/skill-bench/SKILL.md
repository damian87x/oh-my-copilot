---
name: skill-bench
description: Use with bare /skill-bench, history filters, check, latest, code-review, tdd, ralplan, debug, or direct --models selection.
---

# Skill Bench

Run packaged benchmark. Pick skill. Pick model mode. Report result.

## Commands

| command | run | model mode |
|---|---|---|
| `/skill-bench` or history filters | rank local skill history, then ask once | user chooses |
| `/skill-bench check` | scorer self-test | none |
| `/skill-bench latest` | rescore newest saved run | none |
| `/skill-bench code-review` | `code-review-sqli` | host default |
| `/skill-bench tdd` | `tdd-slugify` | host default |
| `/skill-bench ralplan` | `ralplan-pwreset` | host default |
| `/skill-bench debug` | `debug-inflight-dedup` | host default |
| `/skill-bench code-review --models default` | `code-review-sqli` | available reference grid |
| `/skill-bench code-review --models gpt-5.6-luna` | `code-review-sqli` | named model(s) |

Replace `code-review` with `tdd`, `ralplan`, or `debug` in either `--models` form.

Direct input shape: `SKILL` or `SKILL --models VALUE`. Reject extra flags. A direct live mode is consent
to spend benchmark quota. The containing Copilot turn still uses its session model.

## Model modes

- No `--models`: use host default. Best default. Works when an organization disables named models.
- `--models default`: use runner reference grid. Probe models first. Skip only unavailable models.
- `--models MODEL[,MODEL...]`: run exactly named models. Example: `/skill-bench code-review --models gpt-5.6-luna`.

`default` means reference grid. No flag means host default. Do not confuse them.

The runner validates model slugs and probes entitlement. If every requested model is unavailable, stop.
Do not replace requested models with GPT-5 Mini, Haiku, or another fallback.

Reference grid gives repeatable comparison. Host-default and custom runs answer a local question. Do not
declare one winner across different model modes.

## History mode

Guided history accepts no arguments (default `30d all`), positional `7d|30d|90d|all` and `current|all`,
`--window`, `--since`, and `--project`. Normalize default to exactly
`omp history analyze --window 30d --project all --json`. Normalize filtered input to exactly
`omp history analyze --window <window> --project <project> --json`.

Always require a successful schema-version-1 history report before invoking `/grill-me`. Missing, unknown, or
failed history stops here. Large shell output saved to a file is valid: parse that JSON file.

Read ranked entries from top-level `skills` array and top-level `unsupportedSkills` array. Entries use exactly
`skill`, `invocations`, `sessions`, `lastInvokedAt`, `benchmarkable`, and `benchmarkTask`. Display only
`code-review`, `tdd`, `ralplan`, and `debug` as benchmarkable. List observed unsupported skills separately.

History chooses the skill, not the model. Select the first ranked supported skill. Call the `skill` tool with `skill: "grill-me"`. Do not call `ask_user` directly before loading it.

After loading `/grill-me`, ask exactly one question. Name selected skill. Offer host default, reference
grid, named model(s), or stop. Ask for explicit affirmative confirmation before live cells. A named
model choice is explicit confirmation. Silence, empty answer, ambiguity, refusal, unavailable
`/grill-me`, no supported skill, or analyzer failure: stop without starting live benchmark cells.

Only after an unambiguous affirmative answer may the mapped live-mode path run `python3 run.py --task`.
On stop, print direct mode and guided filters: `--since 7d|30d|90d|all`, `--project current|all`.
On stop, never suggest arbitrary project names. History rank alone is never consent.

## Resolve

1. Require `omp` and `python3` on `PATH`.
2. Run `omp version --json`. Use `<packageRoot>/benchmarks/skill-bench`.
3. Require `run.py`. Missing path or command: print it. Stop.

## Run

First run `python3 run.py --selftest`. Require `all instruments valid`.

`check`: self-test only. `latest`: run `python3 run.py --rescore <newest-run-directory>`.

Use same task, arms, runs, workers in every live mode:

```bash
# Host default: omit --models.
python3 run.py --task <mapped-task> --arms baseline,skill,prompt --runs 1 --workers 2

# Available reference grid.
python3 run.py --task <mapped-task> --arms baseline,skill,prompt \
  --models default --runs 1 --workers 2

# Exact user request.
python3 run.py --task <mapped-task> --arms baseline,skill,prompt \
  --models <requested-models> --runs 1 --workers 2
```

Do not silently change models, arms, repetitions, or workers. Preserve runner output. Read its final
`report:` path. Require `sweep_report.html`.

## Report

Open `sweep_report.html` with platform opener. If unavailable, print absolute path.

State model mode first: host default, reference grid, or custom. Then state winner within that mode,
correct and applied percentages, USD and AI credits per successful run, token categories, and missing
telemetry. Do not call every 100% row a winner. Quality first; cost breaks ties.
