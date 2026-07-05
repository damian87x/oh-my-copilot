---
name: history-analyze
description: Analyze past Copilot sessions to derive per-skill invocation patterns, tier mismatches, and a data-driven target model distribution. Reads .omp/state/cost/*.jsonl and daily logs. Emits .omp/routing/history-report.json. Use when the user asks to "analyze copilot history", "find cost savings", "which skills am I using wrong", or before running /routing-plan.
---

# /history-analyze

Read the local cost ledger and memory logs, cluster invocations per skill, and produce a data-driven recommendation of which model tier each skill should use.

## When to use

- User asks about cost, token usage, model spend, or wasted Opus calls
- Before generating a routing plan with `/routing-plan`
- As part of a monthly review (paired with `/daily-log` rollup)

## When NOT to use

- No `.omp/state/cost/` directory exists yet — tell the user to run at least one session with hooks active first
- Fewer than 5 sessions in ledger — surface a "insufficient data" warning and skip tier recommendations

## Inputs

| Source | Path | Read-via |
|---|---|---|
| Cost ledger | `.omp/state/cost/*.jsonl` | `readCostRecords()` from `src/cost/ledger.ts` |
| Daily logs | `.omp/memory/daily/*.md` | plain read |
| Session transcripts | `.omp/memory/sessions/*` | plain read (optional) |
| Capability catalog | `catalog/capabilities.json` | `readFileSync` |

## Algorithm

1. **Load records**: `readCostRecords(cwd, { since: options.since ?? '30d' })`
2. **Per-skill aggregate**: group by `toolName` where event ∈ {`skill.invoke`, `tool.postuse`}
   - `invocations`, `avgTokensIn`, `avgTokensOut`, `avgUSD`, `successRate = 1 - failuresFor(skill)/invocations`
3. **Complexity score** per invocation:
   `complexity = 0.4·norm(inTokens) + 0.3·norm(outTokens) + 0.2·norm(toolCalls) + 0.1·norm(retries)`
4. **Tier recommendation** per skill:
   - median complexity < 0.33 → `haiku`
   - < 0.66 → `sonnet`
   - else → `opus`
   - Override to actual model if `successRate < 0.85` on recommended tier (don't downgrade brittle skills)
5. **Prompt n-grams**: from `daily/*.md` or transcript files, extract top-K bigrams/trigrams per skill → candidate triggers
6. **Distribution**: sum invocations by recommended tier → `targetDistribution` (this replaces hardcoded 80/15/5)
7. **Mismatches**: per skill where `modelActual != modelRecommended`, compute `savingsUSD` using pricing table below

## Pricing (per 1M tokens, per Anthropic public pricing)

| Model | In | Out |
|---|---|---|
| Haiku 4.5 | $1 | $5 |
| Sonnet 4.6 | $3 | $15 |
| Opus 4.7 | $5 | $25 |

Store in `src/routing/pricing.ts` — dated, sourced from the ClaudeGuide reference in `PLAN.md`. Reviewed quarterly.

## Output

Write to `.omp/routing/history-report.json`. See PLAN.md §4.1 for full schema.

Also emit a short human summary to stdout:

```
history-analyze: 42 sessions, 1,847 invocations, $187.40/mo
Recommended distribution: Haiku 68% / Sonnet 24% / Opus 8% (derived)
Top mismatches:
  1. /ralplan on Opus → Sonnet   save $42.10/mo (confidence 82%)
  2. /grill-me on Sonnet → Haiku save $18.30/mo (confidence 91%)
  3. /research-codebase on Opus → Sonnet save $31.20/mo (confidence 74%)
Total projected savings: $126.20/mo (67%)
Next: /routing-plan
```

## CLI

```
omp routing analyze [--since 30d] [--out .omp/routing/history-report.json]
```

## Tests

- Fixture: 3 synthetic ledger files covering ralplan (Opus, low complexity), tdd (Sonnet, medium), ralph (Sonnet, high) — assert tier recommendations
- Edge: empty ledger → exit 0 with warning
- Edge: single-session ledger → skip tier recs, emit invocation counts only

## Cost discipline

This skill is read-only. It emits **one** JSON file. Do not chain into `/routing-plan` automatically — leave the user in control.
