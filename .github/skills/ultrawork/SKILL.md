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

Ultrawork is the **batch-execution** branch of `/omp-autopilot` Phase 3 — a sibling of `/ralph` (single linear task) and `/team` (parallel panes), not nested inside them:
```
/omp-autopilot → /ralph  OR  /team  OR  /ultrawork
```
Pick `/ultrawork` when the work is many independent mechanical items. It can also be invoked directly.

## Steps

### 1. Inventory

Register the batch so the run is tracked and `/team` nudges can see it: `omp ultrawork start "<objective>" --task-count <n>`. Then list all tasks. For each, note the files it touches. Flag any collisions.

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

Summarise: completed, failed, blocked. Then clear the tracked state with `omp ultrawork cancel`.

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

## Cost/token note

This skill can drive multiple tool calls or long-running output. Use `omp cost [--today] [--session <id>]` for local hook-ledger estimates only; it is not provider billing. Keep injected summaries concise and prefer bounded output when rerunning noisy commands.
