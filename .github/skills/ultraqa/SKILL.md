---
name: ultraqa
description: Adversarial QA pass that tests behavior, failures, and regressions. Use with /ultraqa after implementation when shallow checks are not enough.
---

# UltraQA

Use `/ultraqa` after implementation when shallow checks are not enough.

## When to use

- Changes are complete but you're not confident they're correct
- The change touches critical paths (auth, payments, data integrity)
- You need to verify edge cases, error paths, and regressions

## Steps

1. **Identify test surface** — what was changed, what could break
2. **Run existing tests** — ensure baseline passes
3. **Test happy path** — does the primary use case work?
4. **Test edge cases** — empty inputs, boundary values, concurrent access
5. **Test error paths** — what happens when things fail? Timeouts, bad data, missing deps
6. **Test regressions** — did anything that used to work now break?
7. **Cycle** — if issues found, fix and re-run. Repeat until clean.

## Rules

- Prefer runnable checks over inspection — run tests, don't just read code
- If tests don't exist, write minimal ones that cover the change
- Stop cycling after 5 iterations — if still failing, report remaining issues
- Route fixes back to `/ralph` or `/ultrawork` if needed

## Output

- `Scenarios` — what was tested (happy, edge, error, regression)
- `Results` — PASS/FAIL for each scenario
- `Regressions` — anything that used to work but now doesn't
- `Fix recommendations` — what to fix and how, routed to the right skill
