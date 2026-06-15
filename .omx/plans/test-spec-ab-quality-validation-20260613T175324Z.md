# Test Spec: A/B Quality Validation for Cost/Token Optimization

## Unit / contract tests
- `scripts/lib/minify.mjs` keeps small outputs unchanged.
- Minified outputs include head/tail, omission marker, reduced model-facing tokens, and positive saved-token count.
- `post-tool-use.mjs` preserves raw output and emits `modifiedResult` only when model-facing output is shorter.
- `OMP_MINIFY=0` disables minification and records zero saved tokens.
- Hook outputs remain Copilot v1 JSON, never legacy `continue` / `hookSpecificOutput`.

## Integration tests
- `omp doctor --skip-copilot --hooks` passes and smokes all declared hooks.
- `omp cost --session <id> --json` reports records with raw/model-facing/saved token fields after minified postToolUse events.
- Dry-run fixture script can produce baseline and optimized ledgers from identical payloads.

## Live A/B validation
Run all 5 paired fixtures before any quality claim. Fewer than 5 fixtures may only be reported as an incomplete pilot, not validation.

### Required paired-run controls
- Same repo commit and fixture setup.
- Same prompt text.
- Same CLI binary (`/tmp/omp-v2-bin/omp-v2`).
- Same model/permissions/timeout class.
- Baseline: `OMP_MINIFY=0`.
- Optimized: default environment.

### Required evidence per pair
- Transcript path or tmux capture.
- `.omp/state/cost/<session>.jsonl`.
- Raw output artifact path for optimized run when minified.
- `git diff --name-only` and final patch/diff for task fixtures that edit code.
- Rubric verdict: PASS/PARTIAL/FAIL with reason.

## Acceptance criteria
- Deterministic replay: token savings are reproducible and raw paths exist.
- Live A/B: every required fixture is PASS or no worse than baseline; success-rate percentages are secondary summary evidence only.
- No optimized-only FAIL or worse-than-baseline PARTIAL caused by omitted middle output.
- Any use of raw log by optimized run is recorded as a quality signal, not hidden.
- Final report clearly labels results as estimated and workload-specific.

## Commands
```bash
/tmp/omp-v2-bin/omp-v2 doctor --skip-copilot --hooks
OMP_MINIFY=0 node scripts/post-tool-use.mjs < baseline-payload.json
node scripts/post-tool-use.mjs < optimized-payload.json
/tmp/omp-v2-bin/omp-v2 cost --root <fixture-root> --session <session> --json
```

## Initial benchmark evidence to preserve
- `/tmp/omp-cost-bench-run-20260613T183659/summary.txt`
- `/tmp/omp-cost-bench-run-20260613T183659/baseline-ledger.jsonl`
- `/tmp/omp-cost-bench-run-20260613T183659/optimized-ledger.jsonl`

## Required fixture manifest

Each fixture must define:
- `fixtureId` (`F1` through `F5`)
- `resetCommand`
- `prompt`
- `baselineEnv`: `OMP_MINIFY=0`
- `optimizedEnv`: default environment
- `timeoutMs`: recommended 600000
- `expectedArtifacts`: prompt, tmux pane capture, transcript/capture, cost JSON, ledger JSONL, diff, score JSON
- `passCriteria` and `failureSignals`

## Quality decision rule

Do not approve default-on expansion from percentage alone. Approve only when:
1. all five required fixtures completed paired runs,
2. optimized verdict is not worse than baseline for every fixture,
3. no minified output has a missing raw path,
4. F5 proves user-requested content is not minified, and
5. the report labels token and quality percentages as estimated/workload-specific.
