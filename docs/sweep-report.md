# Skill Routing Sweep Report

Date: 2026-07-05
Scope: all 27 skills under `.github/skills/*/SKILL.md` (frontmatter `description` only — the surface the Copilot CLI host actually routes on), plus the `omp suggest` heuristic (`src/commands/suggest.ts`).

## How routing actually works (context)

There is no router in this repo. The Copilot CLI host matches the user's prompt against each installed skill's frontmatter `description`. That makes the 27 description strings the *entire* routing config we control. `omp suggest` is a separate, disconnected regex advisor (8 rules) that recommends a workflow chain but never gates real invocation.

Consequence: routing quality = description quality. Overlapping, vague, or how-instead-of-when descriptions cause mis-routing, and we can't fix it anywhere else.

## Description quality rubric

Each description was checked for:

- **W** — states *when* to trigger ("Use with /x when …")
- **N** — states when *not* to trigger (negative boundary)
- **D** — contains discriminative keywords not shared with a sibling skill

## Findings

### 🔴 High-confusion clusters (mis-routing likely)

**C1. The "I'm done, now check it" cluster — `verify`, `ultraqa`, `code-review`, `verify-byok`**
All four fire at the same moment (work finished). Boundaries as written:
- `verify` — "Prove completion claims with fresh evidence. Use with /verify before saying done." Extremely terse; no keywords distinguishing it from ultraqa/code-review. A prompt like "check this actually works" matches all four.
- `ultraqa` — "after implementation when shallow checks are not enough" — defined *relative to* verify ("shallow checks") without naming it.
- `code-review` — anchored to "before merge or final handoff", which is also when verify-byok fires.
- `verify-byok` — "Use before merging any PR that touches hooks, comms, team, launch, or skills" — overlaps code-review's merge gate for most PRs in this repo (nearly every PR touches skills).

Fix: give each a distinct anchor — verify = "claims I just made", ultraqa = "hunt for bugs adversarially", code-review = "read the diff as a reviewer", verify-byok = "live paid end-to-end run" — and add explicit "not for X, use /y" cross-references.

**C2. The "just do the work" cluster — `ralph`, `omp-autopilot`, `ultrawork`, `team`**
- `ralph` vs `omp-autopilot`: boundary is "does it need planning first", but neither description says so. "Build this feature autonomously" matches both.
- `ultrawork` — "many independent small tasks" is decent, but "batched safely" is undefined.
- `team` — description describes *how* (tmux panes) rather than *when*; only routes well if the user already knows the feature. Also embeds a CLI-usage note ("use `omp team` only when…") that is operator guidance, not routing signal.

**C3. `worktree` over-triggers on "review a PR"**
`worktree`'s description: "Use when user wants to start a new ticket, **review a PR**, or work on a branch". "Review this PR" is a `code-review` prompt; worktree hijacks it. Fix: change to "check out a PR locally" / "work on a branch in parallel".

### 🟡 Medium issues

**M1. Session-end collision — `daily-log` vs `self-evolve`.** Both say to trigger "at end of session". A wrap-up prompt matches both; neither references the other. Probably want both to fire, but if only one can, the tie is unspecified.

**M2. `weighted-consensus` uses the word "review"** ("to decide, review, or compare options") — collides with code-review on prompts like "review these two approaches". Fix: "compare options / make a decision across models", drop "review".

**M3. `grill-me` vs `ralplan`.** grill-me triggers "before planning" — every ralplan prompt is also a grill-me prompt. Intended sequencing (grill → plan) is nowhere stated in either description.

**M4. `create-skill` has no trigger phrasing** — only skill without a "/x" or user-signal clause; relies entirely on the words "creating skills" appearing in the prompt.

**M5. `qa-browse` vs `ultraqa`** — shared "QA" token. qa-browse's "not write a test suite" negative boundary is good; ultraqa lacks the mirror ("not for browser flows, use /qa-browse").

### 🟢 Good examples (use as templates)

- `slack` — explicit-command-only gate with a stated negative boundary ("Never auto-trigger from natural-language phrases…"). Tightest routing language in the set.
- `ponytail` — long list of literal user phrases ("be lazy", "yagni", "do less"). High-recall, low-collision.
- `qa-browse` — positive trigger + explicit negative ("not write a test suite").
- `schedule` — concrete example prompt embedded in the description.

## Rubric summary

| Skill | W | N | D | Notes |
|---|---|---|---|---|
| caveman | ✅ | — | ✅ | |
| code-review | ✅ | — | 🔴 | C1, M2, C3 collisions |
| create-skill | 🔴 | — | ✅ | M4: no trigger clause |
| daily-log | ✅ | — | 🟡 | M1 |
| debug | ✅ | — | ✅ | |
| goal | ✅ | — | ✅ | |
| grill-me | ✅ | — | 🟡 | M3 |
| jira-ticket | ✅ | — | ✅ | |
| omp-autopilot | ✅ | — | 🔴 | C2 |
| ponytail | ✅ | — | ✅ | template-quality |
| prototype | ✅ | — | ✅ | |
| qa-browse | ✅ | ✅ | 🟡 | M5 |
| ralph | ✅ | — | 🔴 | C2 |
| ralplan | ✅ | — | 🟡 | M3 |
| research-codebase | ✅ | — | ✅ | |
| schedule | ✅ | — | ✅ | template-quality |
| self-evolve | ✅ | — | 🟡 | M1 |
| slack | ✅ | ✅ | ✅ | template-quality |
| tdd | ✅ | — | ✅ | |
| teach | ✅ | — | ✅ | |
| team | 🔴 | — | 🔴 | C2: how, not when |
| ultraqa | ✅ | — | 🔴 | C1, M5 |
| ultrawork | ✅ | — | 🟡 | C2 |
| verify | ✅ | — | 🔴 | C1: too terse |
| verify-byok | ✅ | — | 🔴 | C1 |
| weighted-consensus | ✅ | — | 🟡 | M2 |
| worktree | ✅ | — | 🔴 | C3 |

Only 3 of 27 descriptions state a negative boundary (N column). That is the single cheapest global improvement: add "not for X — use /y" to every skill in a confusion cluster.

## `omp suggest` heuristic (secondary surface)

`src/commands/suggest.ts` has 8 rules covering only ~10 of 27 skills; anything outside them falls to the static `/ralplan → /ralph → /verify` fallback. Gaps: no rule routes to qa-browse, prototype, worktree, schedule, research-codebase, weighted-consensus, teach, or ultrawork-vs-team disambiguation. Covered separately by the routing benchmark (see `benchmarks/skill-bench/`).

## Recommended remediation order

1. C1 rewrite (4 descriptions) — highest mis-routing cost, done-checking is the most common moment.
2. C3 worktree one-word fix — cheapest 🔴.
3. C2 rewrite (4 descriptions) — add "needs planning?"/"parallel?" boundaries.
4. Add negative boundaries ("not for X — use /y") across all cluster members.
5. M-items opportunistically alongside the above.

All rewrites should be validated against the routing benchmark dataset (`benchmarks/skill-bench/routing/`) before/after — see the Tier-1 benchmark for the accuracy gate.
