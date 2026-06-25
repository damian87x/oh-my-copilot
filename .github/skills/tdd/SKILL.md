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

## Loop (Canon TDD — repeat until the list is empty)

0. **List first** — before writing any code, read the **full spec/docstring** and write a
   **test list**: every scenario you need to cover. Don't start from the happy path — walk the
   edge-case taxonomy against the spec and add a line for each that applies:
   - **Boundary** — min/max, zero, empty, first/last, length limits, collapsing/trimming
   - **Empty/Null** — `""`, `None`, empty collection, whitespace-only
   - **Format** — **unicode / accented characters**, emoji, special chars, malformed input
   - **Implicit** — anything the spec *implies* but the prompt didn't spell out
   A requirement that appears in the spec but not your list is the bug you're about to ship.
1. **Red** — turn **exactly one** list item into a concrete test with real **assertions**
   (`assert`, `expect`, `self.assertEqual`); run it and watch it **fail for the right reason**.
2. **Green** — write the minimal code to make that test (and all previous tests) pass.
3. **Refactor** — clean up while tests stay green.
4. **Repeat** — take the next list item; add new items as you discover them. Run the full
   related suite at the end to check for regressions.

## Rules

- Use **executable assertions** — a script that only prints results for a human to eyeball is
  **not a test** and does not count as red-green. Every scenario on the list gets an assertion.
- Work the **whole list**, not just the first case — the bugs hide in the edge cases the prompt
  didn't spell out (unicode/accents, empty input, boundaries).
- Test **behaviour** through public surfaces, not implementation details
- Each test should describe one behaviour — name it clearly (e.g. "returns 404 when user not found")
- Avoid brittle tests that break when implementation changes but behaviour doesn't
- If TDD is impractical for the change (e.g. UI layout, infra config), explain why and use `/verify` instead
- Don't write tests for trivial getters/setters — focus on logic

## Output

- `Test list` — the scenarios you enumerated from the spec (incl. the edge cases)
- `Tests written` — list of test names and what they cover
- `Implementation` — what was changed to make tests pass
- `Refactoring` — what was cleaned up
- `Final test run` — all tests passing (output or summary)
