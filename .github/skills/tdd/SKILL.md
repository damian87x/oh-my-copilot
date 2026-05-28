---
name: tdd
description: Red-green-refactor loop for behavior changes where tests are practical. Use with /tdd when a change can be specified by tests.
---

# TDD

Use `/tdd` when a change can be specified by tests.

## When to use

- You're implementing a feature or fixing a bug that has clear expected behaviour
- The codebase has an existing test framework
- You want to prove correctness incrementally

## Loop (repeat until done)

1. **Red** — write or identify a failing test that describes the desired behaviour
2. **Green** — write the minimal code to make the test pass
3. **Refactor** — clean up the code while keeping tests green
4. **Run** — run the full related test suite to check for regressions

## Rules

- Test **behaviour** through public surfaces, not implementation details
- Each test should describe one behaviour — name it clearly (e.g. "returns 404 when user not found")
- Avoid brittle tests that break when implementation changes but behaviour doesn't
- If TDD is impractical for the change (e.g. UI layout, infra config), explain why and use `/verify` instead
- Don't write tests for trivial getters/setters — focus on logic

## Output

- `Tests written` — list of test names and what they cover
- `Implementation` — what was changed to make tests pass
- `Refactoring` — what was cleaned up
- `Final test run` — all tests passing (output or summary)
