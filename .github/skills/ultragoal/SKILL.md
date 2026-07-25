---
name: ultragoal
description: Use when the user invokes /ultragoal, wants a durable multi-story objective, provides a Ralplan artifact for sequential execution, or requires criterion evidence and independent completion gates.
---

# Ultragoal

Run ordered, durable stories under one active session `/goal`. Ultragoal owns
the plan, evidence, steering audit, and final three-role gate; Goal owns outer
continuation.

## Start

Read the session ID from `[OMP SESSION]`.

1. Run `omp goal status --session-id "<session>" --json`.
2. If no active Goal exists, create one with a unique operation ID.
3. Create the plan with a different operation ID:
   - Direct: `omp ultragoal create "<objective>" --stories-json '<array>' ...`
   - Ralplan: `omp ultragoal create "<objective>" --plan-file "<path>" ...`

Each story object has `title`, `objective`, and `criteria`.

## Execute sequentially

1. `omp ultragoal next ...` starts exactly one pending story.
2. Work only that story.
3. Attach proof to every criterion:
   `omp ultragoal evidence --story-id G001 --criterion-id C001 --summary "<proof>" [--file "<project-file>"] ...`
4. `omp ultragoal checkpoint --story-id G001 ...` rejects incomplete evidence.
5. Repeat until status is `awaiting_gate`.

Every mutation requires a unique `--operation-id`. Replaying the same operation
is safe; reusing it with different input is an error.

## Steering

Use `omp ultragoal steer` only with explicit `--kind`, `--evidence`, and
`--rationale`. Supported kinds: `add`, `split`, `reorder`, `revise`, `annotate`,
and `supersede`. Steering preserves history and invalidates old gate approval.

## Completion gate

Run:

`omp ultragoal gate run --session-id "<session>" --operation-id "<unique>" --json`

This launches distinct restricted Copilot processes for `verifier`,
`code-reviewer`, and `architect`. Completion requires all three to return PASS
at the same plan revision. BLOCK or INCONCLUSIVE creates ordered resolver
stories; execute those and gate again.

Emit `OMP_GOAL_COMPLETE` only after Ultragoal status is `complete`.

## Common mistakes

- Do not run stories in parallel or let Team workers checkpoint them.
- Do not treat a test log as evidence for an unrelated criterion.
- Do not bypass a failed gate; resolve its durable stories.
