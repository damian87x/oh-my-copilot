---
name: verify
description: Evidence-first verification gate for completed work, claims, tests, builds, regressions, and known gaps.
---

# Verify

Prove or disprove the current completion claim with fresh evidence.

## Process

1. State the claim being verified and the minimum evidence needed.
2. Run the smallest relevant checks first, then broader build/typecheck/lint/test checks when applicable.
3. Read outputs before reporting.
4. If a check fails, identify the root cause, fix or route it, and re-run the check.
5. Report known gaps explicitly; do not convert unrun checks into implied success.

## Evidence format

- `PASS/FAIL <check>` — command or method, short output summary, and affected scope.
- `Known gaps` — anything not verified and why.
- `Stop condition` — why verification is complete enough to hand off or finish.
