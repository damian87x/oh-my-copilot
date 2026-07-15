---
name: skill-bench
description: Use when a user wants to compare an arbitrary skill or path across models, quality, cost, latency, or routing.
---

# Skill Bench

Use the active `omp` installation from the user's current project. This skill is the conversational
pair-programmer; `omp skill-bench` owns durable state, execution, evidence, and reports.
Keep the interaction as a durable, resumable pair-design rather than a one-shot JSON command.

It supports an arbitrary skill name, installed skill identity, or filesystem path. History can rank
candidates but never restricts eligibility; the selected arbitrary skill remains user-approved.
There is no fixed skill-to-task mapping or model allowlist.

History guidance comes from Copilot CLI session history under `~/.copilot/session-state`; OMP is only
the parser and orchestrator. Never describe this source as OMP history or report Copilot history as
unavailable merely because a wrapper command is absent.

Do not expose Python. Do not require a package checkout. Do not depend on another skill.
Do not start live benchmark cells until there is an approved frozen design, a hard budget, and
explicit spend confirmation. Synthetic execution only for explicit synthetic/dry-run smoke requests
and never as a fallback for a non-synthetic spec. Freeze earlier if a non-synthetic reviewed manifest is missing the approved Copilot provider, a frozen evaluator, an explicit non-empty execution.allowlistedTools list, explicit hard ceilings for maxUsd, maxCells, maxRuntimeMs, and maxPremiumRequests, or conservative per-cell estimates.
On refusal, ambiguity, missing approval, failed history, unavailable runner, or
failed freeze, stop without starting live benchmark cells and explain the next safe action.

## Start and continue

Resolve one entry mode:

- bare `/skill-bench`: guided discovery with `30d/all` defaults;
- `/skill-bench WINDOW SCOPE`: guided discovery with adjusted filters;
- `/skill-bench SKILL_OR_PATH`: direct design for that exact identity or path.

Run exactly one normalized `omp skill-bench ... --json` command for the resolved entry mode. Do not
print or paste raw JSON. Summarize it for the user, preserve warnings and paths, and continue in the
same skill invocation; returning a draft JSON object is not completion.

For guided output, show the ranked candidates with identity, source, and path. Ask exactly one
unresolved high-impact question: which identity to test. After the answer, rerun direct mode with
the selected identity or path so guided and direct entry converge on one durable draft. Duplicate
names always require explicit path/identity selection.

## Pair-design loop

Move one decision at a time. After each answer, update the reviewed manifest checkpoint and show the
changed section. Cover, in order:

1. selected skill and candidate models;
2. atomic scenarios and action contracts: detect/report, propose, implement/verify, or plan-only;
3. user reference or generator-plus-independent-critic reference, including expected, acceptable,
   forbidden, found/done, missed, false-positive, incorrect, and proof fields;
4. rubric, hard gates, thresholds, disqualifiers, calibration, judge, and human adjudication;
5. matched baseline and skill arms, optional prompt arm, execution profile, and parity;
6. sampling/confidence plus hard USD, premium-request, runtime, and cell ceilings.

Show the manifest diff before any gate approval. Before import/approval/freeze, ensure the reviewed
manifest includes provider {kind:"copilot", approved:true}, a real hashed evaluator descriptor/command,
an explicit non-empty execution.allowlistedTools list, hard ceilings for budgets.maxUsd, budgets.maxCells,
budgets.maxRuntimeMs, and budgets.maxPremiumRequests, and budgets.estimatedCellUsd plus
budgets.estimatedCellPremiumRequests. Import it, then request and record each explicit gate approval through `omp skill-bench resume ... --approve ...`. A prose-only yes, history rank, or saved draft is not permission to freeze or spend. Freeze only after every current hash-bound gate is approved.

## Models and spend

Defaults are recommendations, never restrictions. Show candidate provenance and that enumeration is
incomplete. Model probes can consume provider requests, so ask before probing. If approved, probe
only the explicit model ids by rerunning direct design with each `--model ID` plus `--probe-models`.
Preserve `available`, `unavailable`, and `unknown`; unknown remains selectable, while unavailable is
reported rather than silently replaced.

After freeze, ask separately whether to spend the displayed hard ceilings. Only after an affirmative
answer, run with `--approve-spend`; this records hash-bound spend approval for that frozen semantic
spec. Run pilot first when calibration is needed. Run validated mode only from a frozen spec and
never broaden its budget.

## Results, routing, and export

Present quality and proof gaps first, then cheapest passing and fastest passing per task. Keep
missing token/cost telemetry visibly unknown only after both supported cost sources are unavailable.
When Copilot emits `totalNanoAiu`, use it as direct AI-credit telemetry and convert it to USD
(1 AI credit = $0.01). Otherwise fetch the official GitHub Copilot pricing table once and save the
immutable snapshot as `pricing.json`. Label website-derived USD as a public-price proxy, not a
GitHub Copilot invoice; never guess a tier when aggregate session telemetry cannot select one.
`omp skill-bench report RUN_ID` can backfill missing proxy costs without another model call.
For totals, use the provider total when available; otherwise input + output. Cache-read tokens are
already included in input and must not be added again. Always show this total provenance.

For routing, run `omp skill-bench apply RUN_ID --dry-run` first. Show capability, staleness, scope,
and every conflict. Apply only after explicit approval; Copilot interactive instructions remain
advisory and require a new session.

For publication, preview the export without `--approve`, show every included file, hash, and
redaction, then repeat with `--approve` only after the user approves that exact preview.

## OMP commands

```text
omp skill-bench [<skill-or-path>] [filters] [--model <id>] [--probe-models] [--json]
omp skill-bench resume [<draft-id>] [--import <manifest.json>|--approve <gate>|--freeze]
omp skill-bench run <spec-id-or-path> --pilot|--validated --approve-spend
omp skill-bench report <run-id> [--open|--no-open]
omp skill-bench rerun <run-id>
omp skill-bench apply <run-id> [--scope project|user] [--dry-run]
omp skill-bench export <spec-id-or-run-id> --output <path> [--approve]
```
