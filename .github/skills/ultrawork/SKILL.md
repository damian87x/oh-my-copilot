---
name: ultrawork
description: High-throughput execution for many independent small tasks. Use with /ultrawork when work can be batched safely.
---

# Ultrawork

Use `/ultrawork` when there are many independent, low-conflict work items that can be batched.

## When to use

- 5+ independent tasks with no shared files
- Work is mechanical or repetitive (e.g. "fix all type errors", "update all imports")
- Each task can be verified independently

## Do not use when

- Tasks share files or have ordering constraints — use `/ralph`
- Tasks need design decisions — use `/ralplan` first
- Fewer than 5 items — just do them inline

## Composition

Ultrawork is the **parallelism primitive** in the skill stack:
```
/omp-autopilot → /ralph (persistence) → /ultrawork (parallelism)
```
Ralph wraps ultrawork when a persistent verify loop is needed around batched work.

## Steps

### 1. Inventory

List all tasks. For each, note the files it touches. Flag any collisions.

### 2. Dependency check

If tasks have ordering constraints, group them into **waves**:
- Wave 1: tasks with no dependencies (fire all at once)
- Wave 2: tasks that depend on wave 1 results
- Complete each wave before starting the next

If all tasks are independent, use a single wave.

### 3. Execute

Process each wave. For each task in the wave:
- Execute the change
- Verify it individually (test, lint, type-check)
- Mark as done or failed

### 4. Report

Summarise: completed, failed, blocked.

## Stop conditions

- **Failure rate > 30%** — stop remaining tasks, report what failed and why
- **Shared file collision discovered** — stop, re-partition, or escalate to `/ralph`
- **Ambiguous task** — skip it, escalate to `/ralplan`

## Rules

- Verify each batch before moving to the next
- If a task is ambiguous or risky, escalate — don't guess
- Commit after each successful wave, not at the end

## Output

- `Waves` — how tasks were grouped
- `Completed` — items done with evidence
- `Failed/blockers` — items that couldn't be completed and why
- `Verification` — test/lint/build results per wave
