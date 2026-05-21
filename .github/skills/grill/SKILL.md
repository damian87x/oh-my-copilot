---
name: grill
description: Provider-neutral Socratic grilling for plans, designs, and ambiguous implementation requests. Explore available code/docs first, then ask one sharp question at a time with a recommended answer.
---

# Grill

Stress-test a plan until the decision tree is explicit and shared.

## Contract

- Explore existing code, docs, issues, or plans before asking if the answer can be discovered locally.
- Ask exactly one question at a time.
- For every question, include the recommended answer and why it reduces risk.
- Resolve dependencies between decisions before moving to downstream choices.
- Stop when the remaining ambiguity is low enough to hand off to planning or execution.
- When stopping, produce a short handoff: resolved decisions, remaining risks, recommended next capability, and evidence consulted.

## Output

Use this shape for each round:

1. **Current understanding** — one or two bullets grounded in evidence.
2. **Question** — the single highest-leverage unresolved decision.
3. **Recommended answer** — the default path and tradeoff.
4. **Next branch** — what becomes answerable after this decision.

Do not invent a separate brainstorming mode for MVP. Generate options only when needed to answer the current grill branch.
