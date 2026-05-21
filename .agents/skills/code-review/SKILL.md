---
name: code-review
description: Portable post-implementation code review gate; prefer an opposite or non-author model when available and otherwise produce structured findings.
---

# Code Review

Review the completed diff before final evidence.

## Contract

- Prefer a non-author reviewer or opposite model when the provider can hand off safely.
- Review correctness, regressions, security, maintainability, and scope control.
- Distinguish blocking findings from non-blocking suggestions.
- Cite files and concrete behavior; avoid style-only churn unless it blocks maintainability.

## Output

- `Blocking` — issues that must be fixed before completion.
- `Non-blocking` — follow-ups or simplifications.
- `Architecture status` — `CLEAR`, `WATCH`, or `BLOCK`, with one-sentence rationale.
- `Evidence reviewed` — diff, tests, docs, and any unverified areas.
