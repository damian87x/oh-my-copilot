---
name: loop
description: Gate-driven retry loop — re-run an agent until a shell gate command passes (e.g. PR checks green, tests passing). Use with /loop when a machine-checked condition decides done-ness, not the model's say-so.
---

# Loop

Use `/loop` when a **machine-checked gate** decides done-ness: a test command, a
build, `gh pr checks`, a deploy health probe. The agent keeps working until the
gate exits 0, the iteration cap is hit, or the circuit breaker trips. The gate —
never the model's claim — decides when to stop.

## When to use

- "PR checks are failing — keep fixing until green":
  `/loop --gate "gh pr checks 123" "investigate and fix the failing checks"`
- "Iterate until the tests pass": `/loop --gate "npm test" "make the suite green"`
- "Keep going until the task is done" with no shell gate:
  `/loop "migrate all tests to vitest"` (plain mode)

## Do not use when

- No plan exists yet — use `/ralplan` first
- You just want a recurring read-only check (no fixing) — use `/schedule`
- Work has independent parallel lanes — use `/team`

## Input

- `/loop "<task>"` — **plain mode**: same-session persistence loop, no gate.
- `/loop --gate "<shell cmd>" "<task>"` — **gate mode**: the shell command is run
  after every fix attempt; exit 0 = done, non-zero = keep fixing. `--max N`
  overrides the iteration cap (default 10).

## Steps

### Mode 1 — plain agent loop

1. **Register the loop FIRST** — run `omp ralph start "<task>" --max-iterations N`.
   This is the same machinery as `/ralph`: the agent-stop hook re-prompts until
   you emit the completion sentinel or hit the cap. Skipping registration leaves
   the loop invisible to `omp ralph status`/`cancel`.
2. Work the task slice by slice, verifying each slice (see `/ralph`).
3. When acceptance criteria are genuinely met — with fresh evidence — end the
   loop (`omp ralph cancel`).

### Mode 2 — gate-script loop

1. **Validate the gate first** — run the gate command once yourself before
   looping. If it errors for environmental reasons (missing tool, auth, wrong
   cwd), fix that NOW, not inside the loop. Note the current output: that is the
   failure signature you are fixing.
2. **Pick the driver by gate cost:**
   - **Fast gate** (seconds: `npm test`, `tsc`, `pytest`) → loop **in-session**:
     run gate → exit 0: report PASS with evidence, stop. Non-zero: read the
     failure output, make ONE focused fix, re-run the gate. Repeat up to the cap.
   - **Slow gate** (minutes: CI, `gh pr checks`, deploy probes) → don't burn the
     session polling. Choose one:
     - **2a. Managed schedule (default)** — register a self-terminating job:
       ```bash
       omp schedule add --id loop-<slug> --cron "*/15 * * * *" --max-runs <cap> \
         --prompt "Run: <gate>. If it exits 0: report PASS and run \`omp schedule remove --id loop-<slug>\`. If it fails: <task> — make one focused fix, commit it, stop." \
         --allow-all-tools --cwd <repo>
       ```
       `--max-runs` IS the iteration cap; the default 72h TTL is the final
       safety. Confirm with the user before `--allow-all-tools` (unattended
       full access). Inspect ticks with `omp schedule status --id loop-<slug>`.
     - **2b. Gate-first wrapper (token-frugal)** — green ticks should cost zero
       agent tokens. Write `loop-<slug>.sh`:
       ```bash
       #!/bin/bash
       cd <repo> || exit 1
       <gate> && exit 0            # green: no agent spawned
       omp "Gate failed: <gate>. <task> — make one focused fix and commit it."
       ```
       Register the script with the OS scheduler (crontab/launchd) instead of
       `omp schedule` (which fires prompts only), and record the removal step
       for cleanup. Trade-off: invisible to `omp schedule list` — prefer 2a
       unless token cost matters.
3. **On gate pass** — remove any schedule/wrapper you registered, then report
   PASS with the final gate output as evidence.

## Circuit breaker

If the **same failure signature** (same failing check / same test / same error)
appears **3 times** after 3 different fix attempts, **stop**. Report:

- What was tried
- Why each attempt failed
- What information is missing

Do not keep trying the same approach. Escalate the blocker.

## Scope freeze

Fix only what the gate complains about. If you discover unrelated broken work:
note it under "Known gaps", do not chase it — unless it blocks the gate, in
which case stop and report.

## Rules

- The gate decides done-ness — never declare PASS without a fresh gate exit 0
- One focused fix per iteration; don't batch speculative changes
- Commit working increments on the PR/task branch
- Read the gate output — don't assume green means pass
- Every schedule/wrapper you create gets removed when the loop ends

## Final checklist

Before claiming done:
- [ ] Final gate run exited 0, output attached as evidence
- [ ] Iteration cap and circuit breaker respected (not silently bypassed)
- [ ] All schedules/wrappers registered by this loop are removed
- [ ] Fixes committed; no unrelated files touched

## Output

- `Done` — gate status and what was fixed per iteration
- `Evidence` — final passing gate output (and failing outputs along the way)
- `Known gaps` — anything intentionally left or discovered but out of scope

## Cost/token note

Gate loops can drive many tool calls and long outputs. Use `omp cost [--today]`
for local hook-ledger estimates only; it is not provider billing. Prefer 2b's
gate-first wrapper for long CI watches so green ticks cost no tokens.
