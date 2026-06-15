# PRD: A/B Quality Validation for Cost/Token Optimization

## RALPLAN-DR Summary

### Principles
1. Quality evidence outranks token savings: no default-on expansion without outcome comparison.
2. Compare like-for-like: same task, same prompt, same repo state, same model class, same time budget.
3. Preserve observability: record raw logs, model-facing logs, ledgers, transcripts, diffs, and final verdicts.
4. Conservative rollout: minify noisy tool output only; keep opt-out and raw-path recovery.
5. Honest reporting: label all tokens as estimates and all live-run percentages as workload-specific.

### Decision drivers
1. Detect quality regression from omitted middle output before users rely on minification broadly.
2. Quantify token savings on realistic workflows, not only synthetic hook replay.
3. Produce repeatable evidence that can be rerun after minifier/parser changes.

### Viable options

#### Option A — Deterministic hook replay only
Pros: cheap, fast, repeatable; isolates minimizer math.
Cons: cannot measure agent quality, retry behavior, or task success.
Use: regression guard, not product-quality approval.

#### Option B — Paired live Copilot tmux tasks with manual/automated rubric
Pros: measures task outcome, retries, need for raw log, and token savings in real harness flow.
Cons: slower, noisier, may consume quota; requires careful fixture design.

#### Option C — Hybrid validation (chosen)
Pros: hook replay guards token math; paired live tasks measure quality on representative cases; combines speed and realism.
Cons: more setup than replay-only; live results remain workload-specific.

## Decision
Use the hybrid validation path. Keep deterministic hook replay as the stable lower-level regression test and add a small paired live A/B suite for quality retention before making broader claims.

## Scope
Validate the current Phase 3 slice: oversized `postToolUse` output minimization plus ledger savings. Do not validate budget gates, retry-cost guidance, model router, or provider billing.

## Users / stakeholders
- Maintainer deciding whether to keep minifier default-on.
- Future agents needing evidence before changing thresholds/parsers.
- Users concerned that lower token use may hide important debugging context.

## Success metrics
- Token savings: median model-facing postToolUse output tokens reduced by at least 30% on noisy-output fixtures.
- Smoke quality gate: every required fixture is PASS or no worse than its baseline verdict; any optimized-only FAIL caused by omission blocks rollout.
- Percentages are secondary: success-rate percentage is reported only after the smoke gate passes and is labeled workload-specific.
- Recovery: 100% of minified outputs with savings include a valid raw output path.
- Safety: 0 cases where file-read/user-requested content is minified in the fixture suite.

## Required validation fixtures
All five fixtures are mandatory before any quality/safety claim.

| ID | Fixture | Reset/setup | Exact live prompt | PASS criteria | Special risk |
| --- | --- | --- | --- | --- | --- |
| F1 | Successful noisy test log | checkout fixture branch/dir; generate 300+ passing log lines | `Run the noisy passing test command, summarize result, do not edit files.` | Correctly reports success, no unnecessary edits, ledger shows savings | harmless success log should trim aggressively |
| F2 | Failing test in middle | fixture has one failing test block embedded in noisy output | `Run the test, identify the failing test and minimal likely fix; do not apply fix.` | Names failing test/file/error from omitted-middle area or uses raw path to recover | minifier may hide critical middle failure |
| F3 | TypeScript compile errors | fixture contains deterministic `tsc` errors in multiple files | `Run typecheck and report exact actionable file/line errors.` | Reports all required file/line errors or clearly opens raw path for full list | error blocks must not be lost |
| F4 | ESLint/build noise with one actionable error | fixture emits long build log plus one lint/build error | `Run the build/lint command and identify the single actionable error.` | Identifies correct actionable error and avoids chasing noise | summaries must preserve actionability |
| F5 | User-requested file/content read | prompt explicitly asks for full content of a known file/output | `Read and return the requested content exactly; do not summarize.` | Output is not minified and content remains complete | user-requested content must never be silently dropped |

## A/B protocol
For each fixture:
1. Reset repo fixture state with the fixture-specific reset command recorded in `fixtures/<id>/reset.sh` or equivalent.
2. Run baseline with `OMP_MINIFY=0`.
3. Run optimized with default minifier.
4. Use same task prompt, model class, timeout, and tool permission mode.
5. Capture transcript, final diff, raw logs, ledger, and command exit status.
6. Score independently against acceptance criteria before looking at token deltas.

### Live tmux harness contract
Future execution should add a harness equivalent to:

```bash
tools/bench/ab-quality-live.mjs \
  --omp-bin /tmp/omp-v2-bin/omp-v2 \
  --fixtures F1,F2,F3,F4,F5 \
  --runs baseline,optimized \
  --baseline-env OMP_MINIFY=0 \
  --timeout-ms 600000 \
  --artifact-dir .omp/state/bench/ab-quality-<timestamp>
```

The harness must create one artifact directory per fixture/run:

```text
.omp/state/bench/ab-quality-<timestamp>/
  F1/baseline/{prompt.txt,tmux-pane.txt,transcript.txt,cost.json,ledger.jsonl,diff.patch,score.json}
  F1/optimized/{prompt.txt,tmux-pane.txt,transcript.txt,cost.json,ledger.jsonl,diff.patch,score.json,raw-paths.txt}
  ...
  summary.json
  summary.md
```

`score.json` must contain `{fixtureId, run, verdict, reason, rawLogOpened, omittedOutputIssue, toolCallCount}`.

## Scoring rubric
- PASS: task completed, correct diagnosis/fix, no hidden critical detail.
- PARTIAL: useful progress but missing one non-critical detail or needed raw log recovery.
- FAIL: wrong diagnosis/fix, missed critical omitted detail, or task aborted due minified output.

## Stop rules
- Stop rollout and revise minimizer if any fixture shows baseline PASS and optimized FAIL due omitted output.
- Stop if optimized verdict is worse than baseline on any required fixture and the cause is minification or missing context.
- Stop if raw path is missing or unreadable for any minified output.
- Stop if F5 is minified or incomplete.
- Stop if tool-call count drifts by more than 25% without explanation.
- Stop if live runs are not comparable due environment/model/session instability; report session-estimate-only.

## Reporting
Publish a table with per-fixture baseline vs optimized:
- task status
- estimated postToolUse raw/model-facing/saved tokens
- total hook-ledger tokens
- tool-call count
- whether raw log was opened
- final diff correctness
- notes on quality changes

## Out of scope
- Provider billing claims.
- General model-quality claims outside tested fixtures.
- Replacing built-in edit tools or implementing hashline MCP.
