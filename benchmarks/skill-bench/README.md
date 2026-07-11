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
| `tdd-slugify` | `tdd` | a `slugify()` stub (spec also needs accent transliteration) | a real **test file** with assertions | the impl passes all 11 checks, incl. accented/unicode input |
| `code-review-sqli` | `code-review` | **two** planted defects in `users.py` (SQL injection + `SELECT *` leaking `password_hash`) | the **injection flagged** + a verdict given | **both** defects caught |
| `ralplan-pwreset` | `ralplan` | two stub modules | ≥3 of {slices, acceptance, tests, risks}, task-anchored, **stopped at the plan** | also covers ≥2 security specifics (expiry / replay / rate-limit) |
| `debug-inflight-dedup` | `debug` | a localized request deduplicator with two coupled state bugs | evidence-backed diagnosis plus a real regression test | locale isolation, same-key deduplication, and retry after failure all pass |

- **`applied`** = did the skill's discipline show up? (the skill's whole point)
- **`correct`** = is the artifact sound?
- Soft quality (is the plan actually *good*?) is graded separately by `judge.py` — a fixed model
  at temperature 0 with a published rubric, validated by its own selftest first.

### Token and cost provenance

For Copilot CLI cells, the runner uses the session ID from `_cli.json` to read the completed
session's `session.shutdown` event. That is the same underlying accounting shown by Copilot's
session information: uncached input, cached input, cache writes, output tokens, and
`totalNanoAiu`. Each cell caches this immutable telemetry in `_usage.json` so later rescoring does
not depend on the live session store.

- **Direct cost:** `totalNanoAiu / 1,000,000,000` gives AI credits; one AI credit is `$0.01`.
- **Independent check/fallback:** each run saves `pricing.json`, fetched once from
  [GitHub's official Copilot model-pricing page](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing),
  and recomputes cost from all four token categories when one pricing tier unambiguously
  applies. Aggregate session telemetry cannot safely choose among multiple pricing tiers or
  split tokens across multiple models, so those checks are marked unresolved instead of
  guessed.
- **Legacy plans:** premium requests stay visible as a separate quota metric. They are not mixed
  into USD or AI-credit values.
- **Winner:** highest `correct%`, then highest `applied%`; only then do USD/win, legacy
  premium-requests/win, and seconds/win break ties.

If the direct session total and website-rate calculation differ, the HTML report flags it and
keeps the direct Copilot total authoritative. This can happen when a historical run is rescored
against a newer pricing snapshot. If any cell is missing cost telemetry, or a row mixes direct
and estimated sources, the aggregate cost stays blank so incomplete data cannot win a
cheapest-model tie-break.

## Findings so far (Claude Haiku 4.5, n=3/arm)

Run on the Copilot CLI against Claude Haiku 4.5, with each task's hard requirement moved **out of
the prompt and into the spec/seed** — so only a genuine *process* (test-first, thorough review,
careful planning) can surface it. That neutral-prompt design is what makes the arms separate;
state the requirement in the prompt and every arm passes, telling you nothing.

**Process axis (`applied%` — did the skill's discipline show up):**

| skill | baseline | prompt | skill | reading |
|---|---|---|---|---|
| `code-review` | 0.33 | 0.67 | **1.00** | **skill beats both** — the only arm that reliably emits a structured verdict ✅ |
| `ralplan` | 0.67 | 1.00 | 1.00 | beats baseline, **ties** the one-line prompt |
| `tdd` | 0.00 | 1.00 | 1.00 | writes real tests where the bare agent writes none, but **ties** the one-liner |

**Outcome axis (`correct%`):** saturates at 1.0 when the prompt states the requirement; with
neutral prompts it drops and goes noisy (e.g. `tdd` 0.00 → 0.33, *equal* for skill and prompt).

**Takeaways**

1. **Only `/code-review` clearly beats its own one-line description.** Its "don't stop at the
   first issue / check data exposure" guidance reliably produces a verdict the bare agent (0.33)
   and a one-liner (0.67) miss.
2. **`/tdd` and `/ralplan` tie the one-line prompt.** On a capable model, their elaborate
   `SKILL.md` isn't earning its keep over a sentence. Rewriting `/tdd` around **Canon TDD**
   (test-list-first + an edge-case taxonomy) lifted outcomes off zero but did **not** open a gap
   versus the prompt — the lever is task difficulty / model tier, not more prose.
3. **A skill that ties a one-liner is a signal to simplify it**, not to add words.
4. **n=3 is noisy** — treat single-run deltas as directional and raise `--runs` for a verdict.
   `correct%` only discriminates when the difficulty lives in the spec, not the instruction.

> The benchmark earning its keep: it says, with evidence, *which* skills beat just asking — and
> for these three at this model tier, that's `code-review`, not `tdd` or `ralplan`.

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
python3 run.py --task debug-inflight-dedup --runs 5
python3 run.py --all --engine claude --runs 3 # run against the claude CLI instead
```

Workspaces are kept under `runs/<stamp>/` for inspection. Re-score without re-spending:

```bash
python3 run.py --rescore runs/<stamp>
```

Rescoring never invokes a model. If an older run has no `pricing.json`, it may make one public
HTTP request to GitHub Docs before regenerating `summary.json` and `sweep_report.html`.

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
