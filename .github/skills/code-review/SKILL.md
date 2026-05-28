---
name: code-review
description: Review completed changes for blockers, regressions, security, and scope drift. Use with /code-review before merge or final handoff.
---

# Code Review

Use `/code-review` before merge or final handoff.

## When to use

- Changes are complete and ready for review
- You need a second opinion before shipping
- You want to catch regressions, security issues, or scope drift

## Steps

1. **Read the diff** — `git diff` for unstaged, `git diff --staged` for staged, or `git diff main...HEAD` for branch diff
2. **Check for blockers** — bugs, logic errors, missing error handling, broken contracts
3. **Check for security** — secrets in code, injection risks, auth gaps, unsafe defaults
4. **Check for regressions** — does the change break existing tests or documented behaviour?
5. **Check for scope drift** — does the change do more or less than requested?
6. **Run tests** if they exist and haven't been run

## Rules

- Only flag issues that genuinely matter — no style nits, no formatting opinions
- If the code works, tests pass, and scope is right, say so clearly
- Flag anything you'd reject in a PR review

## Output

- `Verdict` — PASS / NEEDS_CHANGES / BLOCKER
- `Blocking` — issues that must be fixed before merge
- `Non-blocking` — suggestions or observations
- `Evidence reviewed` — what was checked (diff, tests, build)
