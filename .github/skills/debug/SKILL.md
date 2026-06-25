---
name: debug
description: Reproduce, minimize, diagnose, fix, and regression-test a bug. Use with /debug for broken, failing, slow, or confusing behavior.
argument-hint: "<symptom or error message>"
---

# Debug

Use `/debug` for broken, failing, slow, or confusing behavior.

## When to use

- Tests are failing
- Something is broken or throwing errors
- Performance is unexpectedly slow
- Behaviour is confusing or inconsistent

## Steps (follow in order)

1. **Reproduce** — get the failure to happen reliably. If you can't reproduce, that's important information. For a web UI bug, use `/qa-browse` to drive the page and reproduce the broken flow.
2. **Minimise** — find the smallest case that still fails. Strip away unrelated code/config.
3. **Hypothesise** — form 2–3 ranked theories about the cause. Start with the most likely.
4. **Inspect** — gather evidence for/against each hypothesis. Read code, add logging, check state.
5. **Fix** — address the root cause, not just the symptom. If the fix is in the wrong layer, note it.
6. **Regression test** — add or run a test that would have caught this bug. Verify it passes now.

## Rules

- Never guess-and-check without a hypothesis
- If the first fix doesn't work, don't keep patching — re-examine the hypothesis
- Document what you tried and why it did/didn't work

## Output

- `Repro` — steps to reproduce the issue
- `Cause` — root cause with file:line evidence
- `Fix` — what was changed and why
- `Regression test` — test that proves the fix and prevents recurrence
