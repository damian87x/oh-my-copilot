---
name: ultrawork
description: High-throughput execution for many independent small tasks. Use with /ultrawork when work can be batched safely.
---

# Ultrawork

Use `/ultrawork` when there are many independent, low-conflict work items that can be batched.

## When to use

- 5+ independent tasks with no shared files
- Work is mechanical/repetitive (e.g. "fix all type errors", "update all imports")
- Each task can be verified independently

## Steps

1. **Inventory** — list all tasks, confirm they're independent (no shared file conflicts)
2. **Batch** — group tasks into batches that can run in parallel
3. **Execute** — process each batch, verify each item
4. **Report** — summarise completed, failed, and blocked items

## Rules

- Avoid shared-file collisions — if two tasks touch the same file, they're not independent
- Verify each batch before moving to the next
- If a task is ambiguous or risky, escalate it to `/ralplan` instead of guessing
- Stop and report if failure rate exceeds 30%

## Output

- `Batch` — what was grouped together
- `Completed` — items done with evidence
- `Failed/blockers` — items that couldn't be completed and why
- `Verification` — test/lint/build results
