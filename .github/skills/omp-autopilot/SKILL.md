---
name: omp-autopilot
description: Full lightweight flow from research to plan, execution, review, and verification. Use with /omp-autopilot only for clear autonomous work. (Renamed from /autopilot to avoid collision with the Copilot CLI built-in.)
---

# OMP Autopilot

Use `/omp-autopilot` only for clear autonomous work where the goal is unambiguous.

## When to use

- The task is well-defined and can be completed without human input
- You have enough context to proceed end-to-end
- The work is not destructive or credential-dependent

## Flow

1. `/research-codebase` — understand the current state
2. `/grill-me` — only if ambiguity remains after research
3. `/ralplan` — create implementation plan
4. `/team`, `/ralph`, or `/ultrawork` — execute based on plan shape
5. `/code-review` — review the changes
6. `/verify` or `/ultraqa` — prove it works
7. `/jira-ticket` — if tracking is needed

## Rules

- Do not skip verification — step 6 is mandatory
- Ask only for destructive, credentialed, or materially ambiguous choices
- If any step reveals the task is more complex than expected, pause and report
- Commit working increments, not one giant commit at the end
