---
name: ralph
description: Single-owner execute-fix-verify loop for one clear task. Use with /ralph when one agent should keep going until evidence or blocker.
---

# Ralph

Use `/ralph` when one owner should complete one clear task end-to-end.

## When to use

- A plan or concrete task already exists
- The work is a single logical unit (not parallelisable)
- You need persistent execution until done or blocked

## Steps

1. **Start** from a plan, ticket, or concrete task description
2. **Implement** in small, verifiable steps
3. **Verify** after each meaningful change — run tests, lint, type-check
4. **Fix** any failures immediately before moving on
5. **Repeat** until the task is complete with evidence, or a blocker is hit
6. **Stop** only with:
   - Evidence of completion (test output, build success, behaviour demo)
   - A documented blocker that requires human input

## Rules

- Never claim "done" without running verification
- If a fix attempt fails 3 times on the same issue, stop and report the blocker
- Commit working increments — don't batch everything into one commit
- If scope creep appears, note it but don't chase it

## Output

- `Done` — what was completed
- `Evidence` — test output, build logs, or behaviour proof
- `Known gaps` — anything intentionally left or discovered but out of scope
