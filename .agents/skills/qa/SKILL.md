---
name: qa
description: Portable QA gate for smoke checks, hostile scenarios, regression probes, and final evidence before handoff.
---

# QA

Exercise the finished behavior as a user or downstream agent would.

## Contract

- Derive hostile scenarios from the acceptance criteria and changed files.
- Run available automated checks first, then targeted manual/smoke checks if automation is missing.
- Verify failure modes and fallback messages, not just the happy path.
- Keep this as a gate; do not create a full provider-native QA runtime in Phase 1.

## Output

- `Scenario` — what was tested.
- `Result` — pass/fail and evidence.
- `Regression risk` — remaining risk and recommended follow-up.
