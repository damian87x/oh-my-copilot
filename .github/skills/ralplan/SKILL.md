---
name: ralplan
description: Produce an implementation-ready plan with risks, acceptance criteria, and test shape. Use with /ralplan when edits need planning first.
---

# Ralplan

Use `/ralplan` when the task needs planning before edits.

## When to use

- The change touches multiple files or components
- There are unclear trade-offs or risks
- You need alignment before implementation

## Steps

1. **Summarise** the target result and constraints in 2–3 sentences
2. **List implementation slices** in execution order — each slice should be independently verifiable
3. **Define acceptance criteria** — what must be true when done
4. **Define test shape** — which tests to write or run, what they cover
5. **Call out risks** — what could go wrong, tradeoffs chosen, alternatives rejected
6. **Stop at the plan** unless the user explicitly asked to implement

## Output

- `Plan` — ordered implementation slices with file-level specificity
- `Tests` — acceptance criteria and test shape for each slice
- `Risks` — tradeoffs, concerns, and what was deliberately not done
- `Ready for` — recommended next skill: `/team`, `/ralph`, `/ultrawork`, or direct edit
