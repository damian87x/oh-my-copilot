---
name: routing-apply
description: Materialize a routing plan into three artifacts Copilot actually reads — copilot-instructions.md router block, per-skill SKILL.md description enrichment, and a userPromptSubmitted hook that logs routing.suggest events. Idempotent, marker-guarded, reversible via /routing-revert. Use after /routing-plan. Trigger phrases: "apply routing plan", "install router", "wire up skill routing".
---

# /routing-apply

Write the three artifacts that make routing actually happen inside Copilot CLI sessions.

## When to use

- After `/routing-plan` has produced `.omp/routing/rules.json`
- When the user is ready to move from advisory→enforcement (add `--enforce`)
- On CI to regenerate router artifacts after a rules PR merges

## When NOT to use

- Working tree is dirty (refuse unless `--force`)
- `rules.json` fails schema validation
- User has never run `/history-analyze` — no evidence base

## Inputs

- `.omp/routing/rules.json` (required)
- Existing `.github/copilot-instructions.md` (edit-in-place with markers)
- Existing `.github/skills/skills/*/SKILL.md` files (enrich in place with markers)
- Existing `scripts/prompt-submit.mjs` (extend)

## Three artifacts

### 1. `.github/copilot-instructions.md` — router block

Insert or replace content between markers:

```markdown
<!-- omp:routing:start v=1 generated=2026-07-05T18:11:00Z -->
## When to use which skill

Progressive-disclosure hints. The model still picks the final skill; these bias the pick.

| If prompt contains… | Use skill | Model tier | Confidence |
|---|---|---|---|
| "plan", "approach", "how should" | `/ralplan` | Sonnet | 82% |
| "clarify", "what am I missing" | `/grill-me` | Haiku | 91% |
| …

<!-- omp:routing:end -->
```

Everything outside the markers is preserved untouched.

### 2. Per-skill `SKILL.md` description enrichment

For each rule, augment the target skill's frontmatter `description:` with a routing-triggers appendix (progressive disclosure literally reads this text to decide when to load the skill). Marker-guarded so re-runs are idempotent:

```markdown
---
name: ralplan
description: Create implementation-ready plans and test shape. <!-- omp:routing:desc:start -->Trigger phrases: "plan for", "how should I approach", "implementation plan". Avoid for: quick prototypes, one-line fixes.<!-- omp:routing:desc:end -->
---
```

### 3. `scripts/prompt-submit.mjs` — advisory hook

Extend the existing `userPromptSubmitted` hook to:

1. Load `.omp/routing/rules.json` (cache in-process for the session)
2. Match the incoming prompt against rules in `priority` order
3. If a rule matches with confidence ≥ threshold (default 0.6):
   - Emit a `routing.suggest` cost-ledger event: `{promptHash, suggestedSkill, suggestedModel, confidence, ruleId}`
   - Print an advisory line to stderr (visible in Copilot session): `"→ omp router suggests /ralplan on Sonnet (82%)"`
4. Never rewrite or block the prompt in v1

Enforcement mode (`--enforce` at apply time, off by default) prepends the suggested slash command to the prompt when confidence ≥ 0.85. Gated behind an explicit flag stored in `.omp/routing/config.json`.

## Safety

- `--dry-run` prints the unified diff and exits — no writes
- All three artifacts have `omp:routing:*` markers → `omp routing revert` restores originals from the pre-write backup at `.omp/routing/backups/<ts>/`
- Refuses to run on dirty tree unless `--force`
- Emits a git commit on success (`chore(routing): apply rules v<n>`) if `--commit` is passed

## CLI

```
omp routing apply [--dry-run] [--enforce] [--force] [--commit] [--rules .omp/routing/rules.json]
omp routing revert                     # restore latest backup
omp routing status                     # show current router state + agreement stats
```

## Tests

- Golden diff for each artifact (snapshot)
- Idempotency: apply twice → second run produces zero diff
- Revert restores byte-identical originals
- Dirty-tree refusal path
- Prompt-submit hook: given prompt X, emits exactly one routing.suggest event with expected payload

## Composition

- Upstream: `/routing-plan`
- Companion: `/routing-report` reads the events this skill emits
- Sibling: `/self-evolve` — if a mistake pattern is "picked wrong skill", it can suggest re-running `/history-analyze → /routing-plan → /routing-apply` as a self-improvement loop
