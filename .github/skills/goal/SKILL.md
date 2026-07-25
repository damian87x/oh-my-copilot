---
name: goal
description: Use when the user invokes /goal, wants a durable objective for the current Copilot session, asks to resume an unfinished objective, or needs turn-based continuation with completion and blocker decisions.
---

# Goal

Own one unfinished objective for the current Copilot session. The AgentStop
hook persists turns and continuation decisions; do not manually increment them.

## Start or inspect

Read the session ID from `[OMP SESSION]` in SessionStart context.

- `/goal <objective>`:
  `omp goal set "<objective>" --session-id "<session>" --operation-id "goal-set-<unique-id>" --json`
- `/goal`:
  `omp goal status --session-id "<session>" --json`

Lifecycle commands are `edit`, `pause`, `resume`, `replace`, `clear`, and
`repair`. Agent decisions use `complete` and `extend`. Mutations require a
unique `--operation-id`; `pause`, `clear`, `complete`, and `extend` also require
`--reason`. Agent decisions must also pass the current `goalGeneration` from
Goal context or `omp goal status` as `--expected-goal-generation`.

## Continuation contract

- Work autonomously while Goal is active.
- After fresh verification, run
  `omp goal complete --reason "<evidence>" --session-id "<session>" --operation-id "goal-complete-<turn>" --expected-goal-generation "<generation>" --json`,
  then emit `OMP_GOAL_COMPLETE` on its own line. The command is authoritative
  on Copilot versions that flush the transcript after AgentStop.
- Emit `OMP_GOAL_BLOCKED {"key":"stable-slug"}` on its own line only for a
  genuine blocker. The same key must persist for three counted turns.
- At turns 20, 40, 60, and 80, decide whether more work is justified. Continue
  only after running
  `omp goal extend --reason "<specific remaining work>" --session-id "<session>" --operation-id "goal-extend-<boundary>" --expected-goal-generation "<generation>" --json`
  during the boundary turn, then emit
  `OMP_GOAL_EXTEND {"reason":"specific remaining work"}` on its own line.
  Otherwise Goal pauses. Turn 100 always stops.

## Quick reference

| Intent | Command |
| --- | --- |
| Change wording | `omp goal edit "<objective>" ...` |
| Pause | `omp goal pause --reason "<why>" ...` |
| Resume | `omp goal resume ...` |
| Replace and reset turns | `omp goal replace "<objective>" ...` |
| Complete with evidence | `omp goal complete --reason "<evidence>" --expected-goal-generation "<generation>" ...` |
| Extend at 20/40/60/80 | `omp goal extend --reason "<remaining work>" --expected-goal-generation "<generation>" ...` |
| Cancel | `omp goal clear --reason "<why>" ...` |
| Repair snapshot/ledger | `omp goal repair ...` |

Example: `/goal finish the auth regression and prove it live` creates the Goal,
then continues until verification supports the completion marker.

## Common mistakes

- Repository north-star: use `/project-goal`.
- Never invent a session ID; use `[OMP SESSION]`.
- Never reuse an operation ID with different input.
