---
name: project-goal
description: Use when the user invokes /project-goal, wants to set or inspect the repository's durable north-star, or asks what the project is trying to achieve across sessions.
---

# Project Goal

Manage the repository-wide objective stored at `.omp/goal.md`. This is distinct
from `/goal`, which owns one unfinished objective for the current Copilot
session.

## Quick reference

- Set: `omp project-goal set "<objective>"`
- Read: `omp project-goal read`
- Clear: `omp project-goal clear`

Use `--json` when another command will consume the result.

## Contract

- `/project-goal <text>` sets one concise, long-lived north-star.
- `/project-goal` reads it.
- Preserve `.omp/goal.md`; the historical `# Repo Goal` file header is a
  compatibility detail, not the public command name.
- Never route this workflow through `omp goal`.

Example: `/project-goal ship a reliable v1` runs
`omp project-goal set "ship a reliable v1"`.

## Common mistakes

- Session task or completion loop: use `/goal`.
- Daily progress: use `/daily-log`.
- Secrets: never store them in the plain-text project goal.
