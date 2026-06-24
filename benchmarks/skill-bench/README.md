# omp skill benchmark

An **agentic** benchmark for oh-my-copilot skills: every cell is a real headless CLI session in
an isolated temp workspace seeded with a starter file, scored on whether the **skill's prescribed
behaviour actually showed up** and whether the produced artifact is sound.

Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/main/benchmarks)'s
agentic harness (MIT). Ponytail measures "does the skill make the agent write _less_ code" — the
right metric for a code-compression skill. omp's skills are **process/orchestration** skills
(`tdd`, `code-review`, `ralplan`, …), so LOC is the wrong yardstick. This harness keeps ponytail's
honest design — real agent sessions, deterministic gates, **selftest before any spend**, an
auditable LLM judge — but swaps the metric to *did the skill do its job*.

## Why this design (and not the single-shot one)

Ponytail's own README flags that the single-shot `promptfoo` bench **overstates wins** because it
counts conversational prose as code. The agentic harness is the honest, defensible one: the
baseline is the **real agent doing the job with no skill**, so any delta is the skill's effect.

## Arms

| arm | what it is | the question it answers |
|---|---|---|
| `baseline` | no skill, the bare agent | what does the agent do unguided? |
| `skill` | the omp skill under test, activated as a plugin | does the skill help? |
| `prompt` | a one-line plain-English instruction matching the skill | **does the skill beat just _telling_ the model to do it?** |

The `prompt` arm is the key control — it's the "you could've just written a sentence" critique,
built in on purpose. If a skill can't beat its own one-line description, that's worth knowing.

## Tasks & metrics

Each task seeds a starter file, runs the agent, and scores **deterministically**:

| task | skill | seed | `applied` means… | `correct` means… |
|---|---|---|---|---|
| `tdd-slugify` | `tdd` | a `slugify()` stub | a real **test file** was written (asserts present) | the impl passes 8 edge-case checks |
| `code-review-sqli` | `code-review` | a SQL-injection bug in `users.py` | the **injection was flagged** + a verdict given | the injection was caught |
| `ralplan-pwreset` | `ralplan` | two stub modules | ≥3 of {slices, acceptance, tests, risks} **and stopped at the plan** | a usable plan (≥3 sections) |

- **`applied`** = did the skill's discipline show up? (the skill's whole point)
- **`correct`** = is the artifact sound?
- Soft quality (is the plan actually *good*?) is graded separately by `judge.py` — a fixed model
  at temperature 0 with a published rubric, validated by its own selftest first.

## Run it

### 0. Selftest first — always, no spend

```bash
cd benchmarks/skill-bench
python3 run.py --selftest        # every scorer: good ref passes, bad ref is caught
```

If this doesn't print `all instruments valid`, the metrics are broken — fix before spending.

### 1. Install the omp plugin (for the `skill` arm)

```bash
copilot plugin marketplace add damian87x/oh-my-copilot
copilot plugin install oh-my-copilot@oh-my-copilot
```

### 2. Live run

```bash
python3 run.py --all --runs 3                 # all tasks, 3 reps, via copilot CLI
python3 run.py --task tdd-slugify --runs 5    # one task
python3 run.py --all --engine claude --runs 3 # run against the claude CLI instead
```

Workspaces are kept under `runs/<stamp>/` for inspection. Re-score without re-spending:

```bash
python3 run.py --rescore runs/<stamp>
```

### 3. Optional: LLM quality judge

```bash
python3 judge.py --selftest          # validate the judge first (small spend)
python3 judge.py --run runs/<stamp>  # grade plan/review quality 0-3 per arm
```

## Host CLI note

`run.py` defaults to `--engine copilot` (omp's real host — skills are Copilot CLI plugins). The
Copilot CLI's non-interactive flags vary by version; **`build_cmd()` in `run.py` is the only
host-specific code** — adjust the flags there if your version differs. `--engine claude` runs the
same tasks against the `claude` CLI, injecting the SKILL.md via `--append-system-prompt`.

## Extending it

Add a skill in three steps:
1. Write a task in `tasks.py`: a `prompt`, a `seed` stub, a deterministic `score()`, and `good`/`bad` references.
2. Add a one-liner for it to `PROMPT_ARM` in `run.py`.
3. Run `python3 run.py --selftest` — if good passes and bad is caught, the instrument is trustworthy.

Pick the metric to fit the skill type:

| skill type (omp examples) | what to measure |
|---|---|
| code-producing (`tdd`, `debug`, `prototype`) | correctness gate, tests-written rate |
| review/QA (`code-review`, `ultraqa`, `verify`) | true-positive rate on seeded bugs, false-positive rate |
| planning (`ralplan`, `grill-me`, `weighted-consensus`) | section presence, "stopped at plan", LLM quality judge |
| orchestration (`team`, `ralph`, `omp-autopilot`) | task-completion %, turns, cost (from CLI JSON telemetry) |

## Credits

Harness design adapted from [ponytail/benchmarks/agentic](https://github.com/DietrichGebert/ponytail/tree/main/benchmarks/agentic)
by DietrichGebert (MIT). Metric and tasks rewritten for omp's process skills.
