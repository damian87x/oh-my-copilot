---
name: routing-plan
description: Convert a history-report.json into a reviewable routing plan (plan.md) and machine-readable rules (rules.json). Assigns each skill a model tier and prompt-trigger set with per-rule confidence and rationale. Use after /history-analyze, before /routing-apply. Trigger phrases: "generate routing plan", "propose skill rules", "draft router config".
---

# /routing-plan

Turn observed patterns into an explicit routing table. Human-review-first: emits a plan document before any config is written.

## When to use

- After `/history-analyze` has produced `.omp/routing/history-report.json`
- When user wants to review router logic before applying
- When user updates trigger phrases and wants to regenerate rules

## Inputs

| File | Purpose |
|---|---|
| `.omp/routing/history-report.json` | Skill stats + tier recommendations |
| `catalog/capabilities.json` | Canonical skill IDs, categories, aliases |
| `.omp/routing/rules.json` (if exists) | Previous rules — merge, don't overwrite user edits |

## Algorithm

1. Load report + catalog. Fail fast if either is missing.
2. For each skill with `invocations >= 3`:
   - Build `triggers.keywords` from top-K n-grams, filtered against a stopword list
   - Build `triggers.regex` for high-signal phrasings (`\bplan\s+for\b`, `\btest\s+shape\b`, etc.)
   - Build `triggers.negativeKeywords` from n-grams of *other* skills that overlap
   - Set `priority` = round(confidence × 100) — higher priority wins ties
3. Merge with any existing `rules.json`:
   - Preserve rules under `<!-- omp:user:start -->` blocks verbatim
   - Bump `version`
4. Emit `plan.md` — human-readable table + phased rollout section styled like `/ralplan` output
5. Emit `rules.json` — validate against `src/routing/rules.schema.json` before write

## plan.md structure

```markdown
# Routing Plan — 2026-07-05
Source report: .omp/routing/history-report.json (42 sessions, $187.40/mo)

## Recommended rules
| Skill | Triggers | Tier | Confidence | Δ$/mo |
|---|---|---|---|---|
| /ralplan | "plan for", "how should I approach" | Sonnet | 82% | −$42.10 |
| /grill-me | "clarify", "what am I missing" | Haiku | 91% | −$18.30 |
| ...

## Phased rollout
- **Phase 1 (advisory only)**: apply rules, emit routing.suggest events for 7 days
- **Phase 2 (measure)**: /routing-report shows agreement rate
- **Phase 3 (enforce)**: only if agreement ≥85% and no regressions in successRate

## Ambiguities requiring review
- /ralph and /ultrawork both match "keep going". Priority breaks tie in favor of /ralph.
- /prototype vs /tdd for "quick spike" — recommend user edit trigger list.
```

## Output

- `.omp/routing/plan.md` — the review doc
- `.omp/routing/rules.json` — machine artifact (see PLAN.md §4.2)

Stdout: one-line summary + path to plan.md + "Review, then run `/routing-apply` (or `omp routing apply --dry-run` to preview)."

## CLI

```
omp routing plan [--report .omp/routing/history-report.json] [--merge]
```

## Tests

- Fixture report → deterministic rules.json (snapshot test)
- Merge preserves user-edited rules under markers
- Missing report → clear error with pointer to /history-analyze

## Composition

Chains with:
- Upstream: `/history-analyze`
- Downstream: `/routing-apply` (advisory), `/routing-report` (measure)
- Sibling: `/self-evolve` can suggest running this after N mistake patterns cluster into a "wrong-skill-picked" theme
