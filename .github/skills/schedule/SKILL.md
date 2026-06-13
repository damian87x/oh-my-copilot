---
name: schedule
description: Register a durable local cron job that re-runs a prompt on a schedule (e.g. "check the PR every 15 min"). Use with /schedule when you want a fresh agent session to fire unattended on an interval and survive reboot.
---

# Schedule

Use `/schedule` to register, inspect, or remove **durable local cron jobs**. Each
job spawns a fresh non-interactive agent session at its interval, survives
machine restart (via the OS scheduler — launchd / systemd / crontab), and writes
results back to the project so the next session sees them.

This is the in-session front-end to the `omp schedule` CLI. You (the agent) run
the `omp schedule …` commands on the user's behalf.

## When to use

- The user wants something to run on a repeat: "check the PR every 15 minutes",
  "run the tests nightly", "poll the deployment hourly".
- The work should keep happening after the terminal closes and across reboots.

## Do not use when

- The user wants a one-shot task now — just do it.
- The user wants to keep iterating within this session — use `/ralph` or `/loop`.

## Steps

1. **Clarify** the prompt to run and the cadence (turn natural language into a
   5-field cron expression, local time). E.g. "every 15 min" → `*/15 * * * *`;
   "weekdays at 9am" → `0 9 * * 1-5`.
2. **Decide tool access.** By default jobs run WITHOUT `--allow-all-tools`, so the
   unattended agent is limited to read-only/allowlisted tools. If the job must
   act (edit files, run commands, push), add `--allow-all-tools` and confirm with
   the user first — it runs unattended with full access.
3. **Register** the job:
   ```bash
   omp schedule add --id <id> --cron "<expr>" --prompt "<text>" \
     [--allow-all-tools] [--cwd <dir>] [--model <m>] [--timeout <ms>] \
     [--max-runs <n>] [--ttl-hours <h>] --json
   ```
   Jobs auto-expire after 72h by default (`--ttl-hours`) — set a longer TTL or a
   `--max-runs` cap as needed. Use `--dry-run` to preview the OS entry first.
4. **Confirm** by listing: `omp schedule list --json`.
5. **Trigger now** to test it once: `omp schedule run-now --id <id>`.
6. **Inspect** results: `omp schedule status --id <id> --json` (recent results
   are also surfaced automatically at the start of future sessions).
7. **Remove** when done: `omp schedule remove --id <id>` (fully uninstalls the OS
   entry; do NOT delete `.omp/state/schedule/` by hand).

## Safety

- Scheduled runs are unattended. Keep prompts specific and bounded.
- `--allow-all-tools` grants full tool access with no human in the loop — opt in
  deliberately, scope the `--cwd`, and prefer a `--max-runs`/`--ttl-hours` cap.
- Overlapping runs are prevented automatically (one run per job at a time), and
  every run is killed at its `--timeout` (default 5 min).

## Examples

```bash
# Babysit a PR every 15 minutes, read-only, for 24 hours
omp schedule add --id pr-watch --cron "*/15 * * * *" \
  --prompt "Check open PRs on this repo and summarize any new review comments." \
  --ttl-hours 24

# Nightly test run that may fix things (full access), capped at 7 runs
omp schedule add --id nightly-tests --cron "0 2 * * *" \
  --prompt "Run the test suite; if anything fails, open an issue with the log." \
  --allow-all-tools --max-runs 7
```

## Cost/token note

This skill can drive multiple tool calls or long-running output. Use `omp cost [--today] [--session <id>]` for local hook-ledger estimates only; it is not provider billing. Keep injected summaries concise and prefer bounded output when rerunning noisy commands.
