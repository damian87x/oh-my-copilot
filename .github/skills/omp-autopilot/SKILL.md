---
name: omp-autopilot
description: Full lightweight flow from research to plan, execution, review, and verification. Use with /omp-autopilot only for clear autonomous work. (Renamed from /autopilot to avoid collision with the Copilot CLI built-in.)
argument-hint: "<task description>"
---

# OMP Autopilot

Use `/omp-autopilot` only for clear autonomous work where the goal is unambiguous.

## When to use

- The task is well-defined and can be completed without human input
- You have enough context to proceed end-to-end
- The work is not destructive or credential-dependent

## Do not use when

- The request is vague or underspecified — use `/grill-me` first
- The change is a single file fix — use `/ralph` directly
- You need human decisions at multiple points — use `/ralplan` then manual execution

## Phases

### Phase 0 — Gate check

If the request is vague (no clear deliverable, multiple interpretations), redirect to `/grill-me` and stop. Do not guess intent.

### Phase 1 — Research

Run `/research-codebase` to understand current state. Skip if you already have full context from the conversation.

### Phase 2 — Plan

Run `/ralplan` to produce an implementation plan with acceptance criteria. If a plan already exists from a prior `/ralplan`, skip this phase.

### Phase 3 — Execute

Route based on plan shape:
- **Independent parallel tasks** → `/team` (tmux panes)
- **Single linear task** → `/ralph` (persistence loop)
- **Many mechanical items** → `/ultrawork` (batch execution)

### Phase 4 — Review

Run `/code-review` on the diff. Fix any issues found before proceeding.

### Phase 5 — Verify

Run `/verify` or `/ultraqa` to prove the work is done. This phase is **mandatory** — never skip it.

## Stop conditions

- **Vague input** → redirect to `/grill-me`, do not proceed
- **Phase fails 3 times** → stop, report the blocker
- **Scope expands beyond original plan** → pause, report new scope, ask whether to continue
- **Destructive or credentialed action needed** → stop and ask

## Composition

```
/omp-autopilot wraps:
  /research-codebase → /ralplan → /ralph or /team or /ultrawork → /code-review → /verify
```

Each inner skill can be invoked independently. Autopilot chains them.

## Final checklist

Before claiming done:
- [ ] Every acceptance criterion from the plan is met
- [ ] Tests pass (if applicable)
- [ ] Lint clean (if applicable)
- [ ] `/verify` or `/ultraqa` produced PASS evidence
- [ ] No uncommitted work left behind
