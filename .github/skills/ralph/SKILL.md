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

## Do not use when

- Work has independent parallel lanes — use `/team`
- 5+ mechanical tasks — use `/ultrawork`
- No plan exists yet — use `/ralplan` first

## Input

Accept a plan from `/ralplan`, a ticket, or a concrete task description. If a `/ralplan` plan exists, use its acceptance criteria as your definition of done.

## Steps

1. **Register the loop FIRST** — before editing any file, run `omp ralph start "<task>" --max-iterations 10`. This is mandatory even for small tasks: it tracks the loop so `omp ralph status`/`cancel` and `/team` nudges can see it and the iteration cap is enforced. Skipping it leaves the loop invisible to the CLI. State what "done" looks like, then start writing code.
2. **Implement** one slice at a time, in plan order.
3. **Verify after each slice** — run tests, lint, type-check. Do not batch verification to the end.
4. **Fix** any failures immediately before moving to the next slice.
5. **Record slice completion** — after a verified slice, `omp ralph tick` may be used for completed-slice bookkeeping only. The agent-stop hook is the sole writer of the loop iteration counter and enforces the cap.
6. **Repeat** until all slices complete with evidence, or a blocker is hit.
7. **Final verification** — run the full test suite one last time after all slices.
8. **End the loop** — run `omp ralph cancel` once done or blocked, so the tracked state is cleared.

## Circuit breaker

If the same issue fails **3 times** after 3 different fix attempts, **stop**. Report:
- What was tried
- Why each attempt failed
- What information is missing

Do not keep trying the same approach. Escalate the blocker.

## Scope freeze

If you discover work outside the original plan:
- **Note it** in your output under "Known gaps"
- **Do not chase it** — finish the planned work first
- If it blocks the plan, stop and report

## Rules

- Never claim "done" without running verification
- Commit working increments — don't batch everything into one commit
- Read test output — don't assume green means pass

## Final checklist

Before claiming done:
- [ ] Every plan slice implemented and verified individually
- [ ] Full test suite passes after all slices
- [ ] No lint or type errors introduced
- [ ] Evidence of completion attached (test output, build log)

## Output

- `Done` — what was completed
- `Evidence` — test output, build logs, or behaviour proof
- `Known gaps` — anything intentionally left or discovered but out of scope
