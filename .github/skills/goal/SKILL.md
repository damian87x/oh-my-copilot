---
name: goal
description: Set or show the repo's durable objective — what we want to achieve in this repo — stored per project at .omp/goal.md. Use when the user says /goal, states the repo's north-star, or asks "what are we trying to achieve here".
---

# Goal

The repo's **durable objective** — the north-star for this project — stored per project at
`.omp/goal.md`. It is distinct from a daily log's per-day goal: this is the long-lived "what
we want to achieve in this repo", set rarely and updated only when the objective changes.

It is read and written through MCP tools:

- `goal_set { goal }` — set/replace the repo objective (one concise line).
- `goal_read` — return the current repo objective.

`cwd` defaults to the current project, so every repo keeps its own goal automatically.

## When to use

- **`/goal <text>`** — the user states the objective; call `goal_set` with one concise line.
- **`/goal`** (no text) — call `goal_read` and show the current objective. If none is set,
  offer to set one.
- The SessionStart hook surfaces the goal as a `[REPO GOAL] …` line, so it is already in
  context at the start of each session — only call `goal_read` when the user asks explicitly.

## Notes

- Keep it to a single north-star sentence; it is not a task list. Use the daily log
  (`/daily-log`) for day-to-day progress toward this goal.
- Update it when the objective genuinely shifts — not every session.
- Do not put secrets in it; `.omp/goal.md` is a plain file readable by anyone with repo access.
