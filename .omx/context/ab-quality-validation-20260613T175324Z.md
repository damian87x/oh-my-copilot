# Context Snapshot: A/B Quality Validation for Cost/Token Optimization

## Task statement
Plan a validation A/B for oh-my-copilot cost/token optimization, then commit the current verified implementation so far.

## Desired outcome
A durable, consensus-reviewed validation plan that proves whether the output minimizer reduces model-facing tokens without causing unacceptable quality drop, plus a commit containing the current hook-schema/cost-ledger/minifier work and planning artifacts.

## Known facts/evidence
- `omp-v2 doctor --skip-copilot --hooks` passed after hooks manifest/schema fixes.
- Full repo verification passed: `npm run build`, `npm test` (68 files / 476 tests), `npm run lint:skills`, `npm run sync:dry-run`, `git diff --check`.
- Deterministic tmux hook replay evidence: `/tmp/omp-cost-bench-run-20260613T183659/summary.txt`.
- Replay measured raw estimated output tokens 7120, optimized model-facing output tokens 2700, saved 4420, reduction 62.08%.
- Current limitation: this proves hook-side model-facing token savings only, not live Copilot task quality or provider billing.

## Constraints
- Do not claim quality parity without task-level A/B evidence.
- Keep raw output accessible; do not silently drop user-requested content.
- Use `OMP_MINIFY=0` as the baseline toggle.
- Use local `/tmp/omp-v2-bin/omp-v2` for oh-my-copilot checks.
- Avoid expensive live Copilot paired runs until the plan defines stop rules and scoring.

## Unknowns/open questions
- Does head/tail minification reduce real agent task success on common failure logs?
- Which task fixtures best represent the user’s real workflows?
- Can we automate paired Copilot runs deterministically enough to compare outcomes fairly?
- What pass/fail threshold is acceptable for quality retention?

## Likely touchpoints
- `scripts/post-tool-use.mjs`
- `scripts/lib/minify.mjs`
- `scripts/lib/cost-ledger.mjs`
- `src/cost/*`
- `test/scripts/post-tool-minify.test.mjs`
- future benchmark harness under `tools/` or `test/bench/` if implemented later
