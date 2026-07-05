# Copilot Routing — Full Plan

**Repo:** [`damian87x/oh-my-copilot`](https://github.com/damian87x/oh-my-copilot)
**Author:** Damian B
**Status:** Draft v1 — ready for `/ralplan` refinement
**Related:** [Anatoli Kopadze on model selection](https://x.com/AnatoliKopadze/status/2073396351279276397)

## 1. Problem

`oh-my-copilot` ships 28 skills, lifecycle hooks, and a token/cost ledger, but **routing is implicit** — the model picks a skill by reading descriptions (progressive disclosure), and model-tier selection is manual. Two failure modes result:

1. **Skill miss** — the right `/skill` isn't invoked because its `description` doesn't match the user's phrasing.
2. **Tier mismatch** — Sonnet/Opus burn tokens on tasks a Haiku-tier model would handle. Published Anthropic guidance targets an [80/15/5 Haiku/Sonnet/Opus split](https://claudeguide.io/claude-haiku-sonnet-opus-which-model); inverted distributions overpay 4–5x.

We already emit the telemetry to fix both (`.omp/state/cost/*.jsonl`, hook events, daily logs). We just don't read it back.

## 2. Goal

Ship a **self-reinforcing routing loop** as three new project skills plus a static report:

```
history-analyze → routing-plan → routing-apply → routing-report
       ↑                                              │
       └──────────  measured on next sessions  ───────┘
```

Success = the router's suggestion agrees with the user's actual pick ≥85% of the time, and monthly ledger cost drops ≥30% within 30 days of applying the first plan.

## 3. How Anthropic / Claude Code route today (spike)

- **Progressive disclosure** — only `name` + `description` (~100 tokens per skill) live in context. Full `SKILL.md` loads on match ([SKILL.md deep dive](https://abvijaykumar.medium.com/deep-dive-skill-md-part-1-2-09fc9a536996)).
- **No first-party model router** — Anthropic publishes the [80/15/5 rule](https://claudeguide.io/claude-haiku-sonnet-opus-which-model) as guidance; you wire it yourself.
- **Semantic routing prior art** — [vLLM Semantic Router](https://www.redhat.com/en/blog/bringing-intelligent-efficient-routing-open-source-ai-vllm-semantic-router) uses a ModernBERT classifier: +10.2% accuracy, −48% tokens.
- **Cost telemetry prior art** — [ccusage](https://www.npmjs.com/package/ccusage), [Tokenomics](https://libraries.io/npm/tokenomics) — both surface the "Opus for 50% of trivial tasks" antipattern.

**Design decision:** we do NOT ship an ML classifier. We ship a **rules table generated from your history**, applied via three cheap layers Copilot already reads:

1. Enriched `description:` frontmatter in each `SKILL.md` (progressive disclosure picks it up)
2. A router block in `.github/copilot-instructions.md` under a managed marker
3. A `userPromptSubmitted` hook that logs router intent to the cost ledger for measurement

This is what Anthropic itself demonstrates in the SDK examples — routing *is* well-written descriptions plus a top-level instruction file.

## 4. Skills

### 4.1 `/history-analyze`

**Path:** `.github/skills/skills/history-analyze/SKILL.md`
**Inputs:**
- `.omp/state/cost/*.jsonl` (all session ledgers) via existing `readCostRecords`
- `.omp/memory/daily/*.md` (daily logs)
- `.omp/memory/sessions/*` (transcripts if present)
- `~/.copilot/history/*` if discoverable

**Emits:** `.omp/routing/history-report.json`

```jsonc
{
  "period": {"from": "2026-06-05", "to": "2026-07-05", "sessions": 42},
  "targetDistribution": {"haiku": 0.68, "sonnet": 0.24, "opus": 0.08, "derivedFrom": "actual"},
  "currentDistribution": {"haiku": 0.12, "sonnet": 0.41, "opus": 0.47},
  "estMonthlyUSD": 187.40,
  "projectedMonthlyUSD": 61.20,
  "skills": [
    {
      "name": "ralplan",
      "invocations": 34,
      "avgTokensIn": 4200,
      "avgTokensOut": 1800,
      "avgUSD": 0.24,
      "successRate": 0.94,
      "topPromptNGrams": ["plan for", "how should i", "implementation plan"],
      "modelActual": "opus",
      "modelRecommended": "sonnet",
      "confidence": 0.82,
      "evidence": "avg output <2k tokens, structured, no chain-of-thought spikes"
    }
  ],
  "mismatches": [
    {"skill": "ralplan", "type": "tier-down", "savingsUSD": 42.10},
    {"skill": "grill-me", "type": "tier-down", "savingsUSD": 18.30}
  ]
}
```

**Key logic:**
- Complexity score per invocation = f(input tokens, output tokens, tool-call count, latency, retry count)
- Cluster invocations per skill; if median complexity < threshold → recommend tier down
- Prompt n-gram top-K becomes candidate trigger phrases for `/routing-plan`
- Target distribution is **derived from data** (per user choice), not hard-coded 80/15/5

**CLI:** `omp routing analyze [--since 30d] [--out .omp/routing/history-report.json]`

### 4.2 `/routing-plan`

**Path:** `.github/skills/skills/routing-plan/SKILL.md`
**Inputs:** `history-report.json` + [`catalog/capabilities.json`](https://github.com/damian87x/oh-my-copilot/blob/main/catalog/capabilities.json)
**Emits:** `.omp/routing/plan.md` (human-reviewable) + `.omp/routing/rules.json` (machine)

`rules.json` shape:

```jsonc
{
  "version": 1,
  "generatedAt": "2026-07-05T18:11:00Z",
  "sourceReport": ".omp/routing/history-report.json",
  "rules": [
    {
      "capability": "planning.consensus",
      "skill": "ralplan",
      "triggers": {
        "keywords": ["plan", "how should", "implementation plan", "approach"],
        "regex": ["\\b(plan|approach)\\s+(for|to)\\b"],
        "negativeKeywords": ["prototype", "quick"]
      },
      "modelTier": "sonnet",
      "rationale": "Median output 1.8k tokens, 94% success on Sonnet in shadow trials",
      "confidence": 0.82,
      "priority": 40
    }
  ]
}
```

`plan.md` is the human-review artifact — same info in a readable table with a phased rollout section (mirrors `/ralplan` output style so it composes with existing review flow).

**CLI:** `omp routing plan [--report .omp/routing/history-report.json]`

### 4.3 `/routing-apply`

**Path:** `.github/skills/skills/routing-apply/SKILL.md`
**Inputs:** `.omp/routing/rules.json`
**Emits (three artifacts Copilot actually reads):**

1. **`.github/copilot-instructions.md`** — appends/replaces a block:

   ```markdown
   <!-- omp:routing:start v=1 -->
   ## When to use which skill
   | If prompt contains… | Use skill | Model tier | Confidence |
   |---|---|---|---|
   | "plan", "approach", "how should" | `/ralplan` | Sonnet | 82% |
   | …
   <!-- omp:routing:end -->
   ```

2. **Per-skill `SKILL.md` frontmatter enrichment** — augments `description:` with routing triggers under a managed section so progressive disclosure surfaces them. Wrapped with `<!-- omp:routing:desc:start -->` / `end` markers so re-runs are idempotent.

3. **`hooks/scripts/prompt-submit.mjs` extension** — runs the router in **advisory mode**: emits a `routing.suggest` event into the cost ledger with `{promptHash, suggestedSkill, suggestedModel, confidence}`. Never blocks or rewrites the prompt in v1 — so we can measure agreement before enforcing.

**Safety:**
- All writes are marker-guarded and reversible via `omp routing revert`
- `--dry-run` shows a full diff first
- Git-clean check refuses to apply if the working tree is dirty (opt out with `--force`)

**CLI:** `omp routing apply [--dry-run] [--rules .omp/routing/rules.json]`

### 4.4 `/routing-report` (static website)

**Path:** `.github/skills/skills/routing-report/SKILL.md`
**Inputs:** ledger + `rules.json` + `history-report.json`
**Emits:** `.omp/routing/report/` — self-contained `index.html` + `data.json` + inline Chart.js (no build step, offline-capable)

**Sections:**
1. **Header** — period, total spend, projected spend, sessions
2. **Distribution** — donut of actual vs target Haiku/Sonnet/Opus mix
3. **Trend** — daily token & USD trend line
4. **Per-skill table** — invocations · avg tokens · $ · current model · recommended · confidence · Δ savings
5. **Router agreement** — once shadow data exists: agreement rate + top disagreements
6. **Recommendations** — plain-English top-3 wins

**CLI:** `omp routing report [--open]`

### 4.5 `/routing-shadow` (optional, v1.1)

Enables the router's `enforce: true` mode after N sessions of shadow agreement above a threshold. Ships as a follow-up.

## 5. Data model additions

New event types on the existing `CostRecord` (fully backwards-compatible — new events, existing fields):

- `routing.suggest` — router picked X, confidence Y, prompt hash Z
- `routing.observed` — user actually ran skill X with model Y (join key = prompt hash)
- `routing.agreement` — nightly rollup

`ompRoot(cwd)/.omp/routing/` becomes the routing home:

```
.omp/routing/
├── history-report.json
├── plan.md
├── rules.json
└── report/
    ├── index.html
    └── data.json
```

## 6. Phased rollout

| Phase | Ships | Success gate |
|---|---|---|
| P1 | `/history-analyze` + report | Report renders on real ledger, produces defensible tier recommendations |
| P2 | `/routing-plan` | Plan diffable, `plan.md` reads clearly, `rules.json` validates |
| P3 | `/routing-apply` advisory | `routing.suggest` events flowing into ledger; router agreement measurable |
| P4 | Enforcement (v1.1) | Only after ≥20 shadow sessions with ≥85% agreement |

Each phase is one PR. Land P1 first — it's read-only, zero blast radius.

## 7. Non-goals (v1)

- No ML classifier (ModernBERT-style). Rules table only. Revisit after 60 days of `routing.suggest` data — if agreement plateaus below 80%, add embedding-based matching as a tie-breaker.
- No cross-project routing. Rules are per-repo.
- No enforced prompt rewriting. Advisory only.
- No API cost integration. Ledger is estimated per existing `estUSD` field; treat as directional.

## 8. Open questions

1. **Copilot CLI model-selection API** — is there a public knob to hint at Haiku vs Sonnet inside a session? If not, the "model tier" recommendation is guidance surfaced in the router block, not automatic dispatch. **Action:** file a GitHub Copilot CLI issue asking for a `--model` hint per slash command.
2. **Prompt hashing** — sha256(prompt) is enough for join keys but leaks nothing useful for debugging. Store first 80 chars of prompt in a separate local-only debug log? Off by default.
3. **Multi-agent sessions** — team/ralph modes fan out. `routing.suggest` needs a `laneId` field to attribute correctly. Trivial to add; noting for implementation.

## 9. Sources

- [Anthropic 80/15/5 model tier guidance](https://claudeguide.io/claude-haiku-sonnet-opus-which-model)
- [SKILL.md progressive disclosure deep dive](https://abvijaykumar.medium.com/deep-dive-skill-md-part-1-2-09fc9a536996)
- [vLLM Semantic Router](https://www.redhat.com/en/blog/bringing-intelligent-efficient-routing-open-source-ai-vllm-semantic-router)
- [ccusage — Claude Code cost telemetry](https://www.npmjs.com/package/ccusage)
- [Tokenomics — Claude Code token intelligence](https://libraries.io/npm/tokenomics)
- [Anatoli Kopadze — model selection thread](https://x.com/AnatoliKopadze/status/2073396351279276397)
- [oh-my-copilot repo](https://github.com/damian87x/oh-my-copilot)
