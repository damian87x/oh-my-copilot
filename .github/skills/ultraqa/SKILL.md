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

## Do not use when

- A simple `npm test` is sufficient — use `/verify`
- You're still implementing — finish first, then QA

## Steps

Register the QA run first: `omp ultraqa start "<goal>" --max-cycles 5`. This tracks the cycle count and enforces the cap, and lets `omp ultraqa status`/`cancel` see the run.

### Cycle 1 (and each subsequent cycle)

Number every cycle explicitly: "Cycle 1", "Cycle 2", etc.

1. **Identify test surface** — what changed, what could break
2. **Run existing tests** — baseline must pass before adversarial testing
3. **Test happy path** — primary use case works
4. **Test edge cases** — empty inputs, boundary values, concurrent access
5. **Test error paths** — timeouts, bad data, missing deps
6. **Test regressions** — did anything that previously worked now break?

### After each cycle

- Record the outcome: `omp ultraqa cycle fail` (issues found) or `omp ultraqa cycle pass` (clean). This increments the counter and reports when the cap is reached.
- If issues found → fix and start next cycle
- If clean → report PASS and run `omp ultraqa cancel` to clear the run
- Track which issues were found and fixed per cycle

## Early exit conditions

- **5 cycles reached** (enforced by `omp ultraqa cycle`) — stop, report remaining issues as known gaps
- **Same failure 3 consecutive cycles** — stop, this is a design issue not a bug. Report it for `/ralplan`
- **Critical regression found** — stop immediately, report before fixing anything else

## Severity routing

- **Critical** (data loss, security, crash) → immediate stop, fix before continuing
- **Major** (broken feature, wrong output) → fix in current cycle
- **Minor** (cosmetic, non-blocking) → log and continue, fix at end if time permits

## Rules

- Prefer runnable checks over inspection — run tests, don't just read code. For web UI flows, exercise the real page with `/qa-browse` rather than inspecting markup.
- If tests don't exist, write minimal ones that cover the change
- Route fixes back to `/ralph` or `/ultrawork` if they're substantial

## Output

- `Cycles` — how many iterations, what was found/fixed in each
- `Scenarios` — what was tested (happy, edge, error, regression)
- `Results` — PASS/FAIL with trend across cycles
- `Regressions` — anything that used to work but now doesn't
- `Known gaps` — remaining issues after max cycles
