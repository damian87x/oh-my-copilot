---
name: verify
description: Prove completion claims with fresh evidence. Use with /verify before saying done.
---

# Verify

Use `/verify` before saying done.

## When to use

- You've completed a task and need to prove it works
- Someone claims "it's done" and you need to confirm
- Before creating a PR or handing off work

## Steps

1. **State the claim** — what is being verified (e.g. "auth flow works end-to-end")
2. **Run checks** — the smallest set of commands/inspections that prove the claim:
   - Tests: `npm test`, `pytest`, etc.
   - Build: does it compile/build without errors?
   - Lint: any new warnings?
   - Behaviour: does the feature work as described? For web UI flows, use `/qa-browse` to drive the live page and capture snapshot/screenshot evidence.
3. **Read outputs** — don't assume green means pass; read the actual results
4. **Report honestly** — if there are gaps, say so

## Rules

- Fresh evidence only — don't rely on previous test runs
- If a check fails, report it as a gap, don't hide it
- Verify what was asked for, not more and not less

## Output

- `PASS` or `FAIL`
- `Evidence` — command output, screenshots, or behaviour description
- `Known gaps` — anything not verified and why
- `Stop condition` — what would need to change for a different verdict
