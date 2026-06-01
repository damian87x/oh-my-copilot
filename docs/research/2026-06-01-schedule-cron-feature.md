---
date: 2026-06-01T08:06:56+01:00
researcher: Damian Borek
git_commit: c0f9a66846698b40b4423066ce980f9a1a34b805
branch: feature/schedule-cron
repository: oh-my-copilot
topic: "How to build a local cron/`/schedule` feature for oh-my-copilot (omp)"
tags: [research, codebase, scheduling, cron, daemon, cli, mode-state, hooks, team-runtime]
status: complete
last_updated: 2026-06-01
last_updated_by: Damian Borek
---

# Research: A local `/schedule` cron feature for oh-my-copilot

**Date**: 2026-06-01 08:06:56 +0100
**Researcher**: Damian Borek
**Git Commit**: c0f9a66846698b40b4423066ce980f9a1a34b805
**Branch**: feature/schedule-cron
**Repository**: oh-my-copilot

## Research Question

How can we add a local cron-job scheduler to oh-my-copilot that works the same way
Claude Code's `/schedule` does — i.e. a recurring local job an agent (or the user)
can register and that fires unattended, e.g. *"check the PR every 15 minutes"*, by
spawning a fresh non-interactive agent session each tick?

This document maps (a) how Claude Code's own `/schedule` works, (b) how oh-my-copilot
is built today and where a scheduler would plug in, and (c) the concrete
implementation approaches available, with a recommendation.

> Note: per the user's explicit request ("research how we can work out this"), this
> document includes a forward-looking *Implementation Approaches* section in addition
> to documenting the current codebase. The "Detailed Findings" sections describe only
> what exists today.

---

## Summary

- **Claude Code's CLI `/schedule`/`/loop`/`Cron*` is an *in-process, session-scoped*
  timer** — no system crontab, no launchd, no separate daemon. Jobs live in RAM in the
  running CLI process, support 5-field cron expressions in local time, cap at 50 tasks,
  auto-expire after 3 days, and die when the session exits. The desktop app has a
  *persistent* variant (survives restart, but needs the app open); cloud "routines" run
  server-side. (Sources below.)
- **oh-my-copilot has no scheduling/timer/cron code today.** The only `setTimeout` uses
  are one-off sleeps and fetch-abort timers — there is no recurring scheduler, no daemon,
  no crontab/launchd/systemd integration anywhere in the repo.
- **oh-my-copilot already has every building block a scheduler needs**, just not wired
  for time: an imperative CLI dispatch (`src/cli.ts`), a JSON-state "mode" pattern
  (`src/mode-state/*` → `.omp/state/*.json`), agent-spawning code (council spawns
  `copilot --model X -p ... --allow-all-tools`; team spawns agents into tmux panes), and
  a lifecycle hook system.
- **Two viable designs**: (A) a Claude-Code-parity in-process/detached **Node daemon**
  holding a cron table loaded from JSON; (B) **delegate to the OS scheduler**
  (crontab / launchd / systemd user timers) so jobs survive reboot with no daemon to
  babysit. **Recommended default: a hybrid** — store job definitions as JSON under
  `.omp/state/schedule/`, install one OS-scheduler entry per job that calls
  `omp schedule run --id=<id>`, and put overlap-locking + per-run logging inside that
  run handler.

---

## Detailed Findings

### A. How Claude Code's `/schedule` works (external research)

Sourced via Perplexity (`sonar-pro`) against the official docs and guides
(`code.claude.com/docs/en/scheduled-tasks`, `claudefa.st`, MindStudio).

There are **three distinct scheduling models** in the Claude ecosystem; only the first
is the `/schedule`/cron the question refers to:

1. **CLI session-scoped tasks** — `/loop`, `/schedule`, and the `CronCreate` /
   `CronList` / `CronDelete` tools.
   - **Mechanism**: an internal timer/wakeup loop *inside the running CLI process*.
     No evidence of system crontab, launchd, or a separate daemon.
   - **Storage**: in-memory only. Docs state "No persistence: restarting Claude Code
     clears all session-scoped tasks." Jobs are not written to disk.
   - **Cron model**: standard **5-field cron expression** (min, hour, dom, month, dow),
     interpreted in **local timezone**. `/loop` accepts natural language
     (`/loop 30m check the build`, `/loop check the build every 2 hours`, default
     every 10 min; units `s/m/h/d`, seconds rounded up to minutes) and converts it to a
     cron string passed to `CronCreate`.
   - **Re-invocation**: when a job is due, the scheduler **injects the stored prompt as a
     new turn into the same conversation** — it does not launch a separate OS process.
     If Claude is mid-response, the job "fires once when idle, not once per missed
     interval" (no catch-up) — classic in-process timer-queue behavior.
   - **Limits/controls**: up to **50 tasks per session**; recurring tasks **auto-expire
     after 3 days**; disable entirely with `CLAUDE_CODE_DISABLE_CRON=1`.
   - **Dependency**: requires the CLI process to stay alive. Close the terminal → jobs
     gone.
2. **Desktop scheduled tasks** — persistent across app restarts, fire a *fresh session*
   per tick, but require the desktop app to be open. Storage format not publicly
   documented.
3. **Cloud routines** (MindStudio) — server-side, run without your machine.

**Implication for omp**: Claude Code's *CLI* model is the simplest (an in-RAM timer),
but its biggest limitation — "dies when the session exits" — is exactly what an
unattended *"check the PR every 15 min"* job needs to avoid. To match the spirit
("fresh agent session each tick") while being *durable*, omp should lean toward the
desktop/OS-scheduler behavior, not the ephemeral CLI behavior.

### B. oh-my-copilot CLI dispatch — where a subcommand plugs in

`src/cli.ts` uses a **single imperative `runCli()`** that parses argv into
`[group, command, value]` and routes via if/else chains. There is **no formal command
registry** — each subcommand is a hardcoded branch.

Existing subcommand groups (representative): `version`, `list`, `setup`, `doctor`,
`launch -- <args>`, `team …`, `team api …`, `council "<q>"`, `mcp`,
`ralph start|status|cancel|tick`, `ultrawork start|status|cancel`,
`ultraqa start|status|cancel|cycle <verdict>`, `catalog …`, `project inspect`,
`skill install`, `lint:skills`, `sync:dry-run`, `jira …`.

To add a scheduler you would:
1. Add a `schedule …` branch in `runCli()` (`src/cli.ts`).
2. Import a handler module (new `src/schedule/*`).
3. Parse flags with the existing `flagValue()` helper.
4. Return the standard `CliResult` (`{ ok, exitCode, message, output? }`).
5. Extend the help text.

This is the exact pattern `ralph`/`ultrawork`/`ultraqa` already follow.

### C. The mode-state pattern — the closest existing analogue

`src/mode-state/{ralph,ultrawork,ultraqa}.ts` + `src/mode-state/paths.ts` implement a
**persisted-JSON state machine**, which is the nearest thing to a scheduler today:

- State is a typed object (`active`, counters, `startedAt` ISO string, `prompt`/
  `objective`/`goal`, `sessionId`, `projectPath`) written to
  `modeStatePath(cwd, "<mode>")` = `{cwd}/.omp/state/<mode>.json`.
- Functions follow a uniform shape: `start*` (write state), `read*` (load), `cancel*`
  (delete file), and an advance function (`tickRalph`, `recordUltraqaCycle`).
- **Crucially, none of these have a timer.** "Looping" is driven externally: the caller
  re-invokes `omp ralph tick`, and the `prompt-submit` hook injects the active state as
  context on the *next* user prompt. They are persistence + context-injection patterns,
  **not** event loops.

A `schedule.ts` mode would reuse this shape but, unlike the others, needs an *actual
time trigger* (a daemon or OS scheduler) to advance itself.

### D. Agent-spawning mechanics — how omp launches a session today

Two existing spawn paths a scheduler could reuse:

1. **Council (direct child process)** — `src/council/index.ts:48-50`:
   ```ts
   spawn(copilotBin, ["--model", req.model, "-p", req.prompt, "--allow-all-tools"],
         { stdio: ["ignore", "pipe", "pipe"] })
   ```
   with a one-off `setTimeout` kill at `src/council/index.ts:58` to enforce `timeoutMs`.
   **This is the cleanest template for a scheduled, non-interactive, captured run.**

2. **Team (tmux panes)** — `src/team/runtime.ts` + `src/team/tmux.ts`. `startTeam()`
   creates `tmux new-session -d … -s omp-team-{name}`, splits panes, then launches the
   worker bin with `tmux send-keys -t {pane} -l -- {bin}` + `C-m`. `resolveWorkerBin`
   picks `claude`/`codex`/`gemini`. This is good for *visible, long-lived* workers but
   heavier than a scheduled tick needs.

`monitorTeam()` (`src/team/runtime.ts:211-268`) shows omp's polling idiom: a
`while` loop with `await sleep(pollInterval)` (default 1000ms, 600s timeout) — **not**
`setInterval`.

### E. Hooks — optional integration surface

`hooks/hooks.json` registers 6 events, each `node <plugin>/scripts/<x>.mjs` with a 5s
timeout, data over stdin as JSON: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SessionEnd`, `Error`.

- `scripts/session-start.mjs` — logs + version check; returns
  `hookSpecificOutput.additionalContext`.
- `scripts/prompt-submit.mjs` — reads active mode-state files and injects
  "RALPH/ULTRAWORK/ULTRAQA ACTIVE …" continuation context before the prompt.

A scheduler could optionally use `session-start` to **surface due/overdue jobs** or even
opportunistically tick them, but the hooks have a **5s budget** and only fire on session
events, so they cannot be the primary time trigger.

### F. State & path conventions

- Project-local root: `{projectRoot}/.omp/state/` (`src/copilot/paths.ts` →
  `resolveCopilotPaths().stateDir`).
- Mode files: `.omp/state/{ralph,ultrawork,ultraqa}.json`.
- Team: `.omp/state/team/{name}/{config.json,tasks/*.json,workers/*/…}` with lock files
  (`tasks/{id}.lock`) acquired via exclusive open (`src/team/task-store.ts`).
- Hook log: `.omp/state/hooks.log` (JSONL).

A scheduler fits naturally as `.omp/state/schedule/` (jobs + per-run logs + daemon
pidfile/locks).

### G. Existing timer/cron inventory (grep results)

No recurring scheduling exists. Every match is a one-shot:

- `src/council/index.ts:58` — `setTimeout` kill (model spawn timeout).
- `src/team/runtime.ts:32` — `setTimeout` `sleep()` helper.
- `src/team/tmux.ts:90` — `setTimeout` `sleep()` helper.
- `scripts/lib/version-check.mjs:35` — `setTimeout` fetch-abort (3s).

No `setInterval`, `cron`, `crontab`, `launchd`, `systemd`, `node-cron`, `schedule`.

---

## Implementation Approaches (forward-looking — the user's explicit ask)

External research (Perplexity `sonar-pro`) compared the scheduling/persistence layer
options for a cross-platform macOS+Linux Node CLI that must survive reboot.

### Option A — In-process / detached Node daemon (Claude-Code-parity)

A long-lived `omp schedule daemon` process holds an in-memory cron table loaded from
JSON and spawns agent sessions at each tick (via the council-style `spawn`).

- **Scheduling lib**: `croner` or `node-cron` (both lightweight, 5/6-field cron, no
  built-in persistence — you load jobs from your own JSON). `node-schedule` is older;
  `bree` adds a worker pool; `agenda` adds durable persistence **but requires MongoDB**
  (too heavy for a CLI).
- **Daemonization**: `child_process.spawn(process.execPath, [daemonScript], { detached: true, stdio: 'ignore' }).unref()`.
- **Lifecycle**: pidfile at `.omp/state/schedule/daemon.pid`; `start`/`stop`/`status`
  via signal-0 liveness checks + `SIGTERM`.
- **Pros**: cross-platform-identical behavior; full control; matches Claude Code's
  "fires a fresh session" model.
- **Cons**: **does not survive reboot on its own** — you still need launchd/systemd to
  relaunch the daemon at boot. You own crash recovery, logging, restart policy. More
  code.

### Option B — Delegate to the OS scheduler (durable, recommended base)

Register one OS-native entry per job; each entry runs `omp schedule run --id=<id>`.

- **Linux (systemd --user)**: write `~/.config/systemd/user/omp-<id>.{service,timer}`
  (`Type=oneshot` service; timer `OnCalendar=*:0/15` or `OnUnitActiveSec=15min`,
  `Persistent=true`), then `systemctl --user daemon-reload && systemctl --user enable --now omp-<id>.timer`.
- **macOS (launchd)**: write `~/Library/LaunchAgents/com.omp.<id>.plist` with
  `ProgramArguments=[omp, schedule, run, --id=<id>]` and `StartInterval`/
  `StartCalendarInterval`, then `launchctl bootout gui/$UID/com.omp.<id> || true` +
  `launchctl bootstrap gui/$UID <plist>`.
- **Cross-platform fallback (crontab)**: manage a delimited block
  (`# BEGIN omp-jobs … # END omp-jobs`) via `crontab -l` → rewrite → `crontab -`.
- **Pros**: **survives reboot for free**; battle-tested; no daemon to babysit; each run
  is a clean process.
- **Cons**: three code paths to template + parse; 1-minute granularity (cron); no
  built-in overlap prevention (must add locking).

### Option C (recommended) — Hybrid: JSON job store + OS scheduler + locked run handler

Combine B's durability with omp's existing JSON-state idiom:

1. **`omp schedule add --id=<id> --cron="*/15 * * * *" --prompt="check PR #42" [--bin copilot] [--cwd .]`**
   → writes `.omp/state/schedule/jobs/<id>.json` (reusing the mode-state JSON pattern),
   then installs the platform-appropriate OS entry (systemd/launchd/crontab) that calls
   `omp schedule run --id=<id>`.
2. **`omp schedule run --id=<id>`** (invoked by the OS scheduler):
   - Acquire a per-job **lock file** (`.omp/state/schedule/<id>.lock`, exclusive
     `open(..., 'wx')` — the same technique `task-store.ts` already uses) to **prevent
     overlapping runs**; exit early if locked.
   - Spawn the agent with the **council template**:
     `spawn(bin, ["-p", prompt, "--allow-all-tools"], {...})`.
   - Capture stdout/stderr to `.omp/state/schedule/logs/<id>/<timestamp>.log`; record
     exit code + `lastRunAt`/`lastStatus` back into the job JSON.
   - Release the lock in `finally`.
3. **`omp schedule list`** → read job JSONs (source of truth) and annotate with the
   installed OS entry's status.
4. **`omp schedule remove --id=<id>`** → delete the JSON + uninstall the OS entry.
5. **`omp schedule run-now --id=<id>`** → manual one-off trigger (same run handler).

This keeps the scheduler's *state* in omp's familiar `.omp/state/` JSON world while
delegating the *time trigger* and *reboot persistence* to the OS — and reuses the
existing exclusive-lock and child-spawn idioms already in the codebase.

### Recommendation matrix

| Approach | Survives reboot | Daemon to babysit | New deps | Cross-platform code paths | Matches "fresh session/tick" | Effort |
|---|---|---|---|---|---|---|
| A: Node daemon (croner/node-cron) | Only if OS-launched at boot | Yes | 1 small lib | 1 (uniform) | Yes | High |
| B: OS scheduler only | **Yes** | No | None | 3 (systemd/launchd/cron) | Yes | Medium |
| **C: Hybrid (JSON store + OS scheduler + locked run)** | **Yes** | No | None | 3 (shared run handler) | Yes | Medium |
| Agenda (Mongo) | Yes | Yes | Mongo | 1 | Yes | High / heavy |

**Default recommendation: Option C.** It is the simplest design that is durable across
reboot, needs no extra runtime dependency, reuses existing omp patterns (mode-state JSON,
exclusive locks, council-style spawn), and faithfully reproduces the
"spawn a fresh agent session each tick" behavior the user asked for — without inheriting
Claude Code CLI's "dies with the session" limitation. Option A's uniform daemon can be
added later as a Windows / no-systemd fallback if needed.

---

## Code References

- `src/cli.ts` — imperative `runCli()` dispatch; where a `schedule` branch + help entry go.
- `src/mode-state/ralph.ts`, `ultrawork.ts`, `ultraqa.ts` — JSON-state mode pattern to mirror for `schedule.ts`.
- `src/mode-state/paths.ts` — `modeStatePath(cwd, mode)` → `.omp/state/<mode>.json`.
- `src/council/index.ts:48-50` — `spawn(copilotBin, ["--model", m, "-p", prompt, "--allow-all-tools"])`: the run-handler spawn template.
- `src/council/index.ts:58` — one-off `setTimeout` kill (per-run timeout pattern).
- `src/team/runtime.ts:211-268` — `monitorTeam()` poll loop (`await sleep()` idiom).
- `src/team/tmux.ts:55-87` — tmux session/pane/send-keys API (heavier alt spawn path).
- `src/team/task-store.ts:63-78` — exclusive lock-file acquisition (reuse for overlap prevention).
- `src/copilot/paths.ts` — `resolveCopilotPaths().stateDir` = `{projectRoot}/.omp/state`.
- `hooks/hooks.json`, `scripts/prompt-submit.mjs`, `scripts/session-start.mjs` — hook surfaces for optionally surfacing due jobs (5s budget; not a primary trigger).

## Architecture Documentation (patterns observed)

- **CLI**: single-file imperative dispatch returning a uniform `CliResult`; subcommands
  are hardcoded branches, not a registry.
- **Mode state**: typed JSON written to `.omp/state/*.json`; `start/read/cancel/advance`
  functions; "looping" is external + hook-injected, never timer-driven.
- **Agent spawn**: non-interactive `-p … --allow-all-tools` via `child_process.spawn`
  (council) or tmux `send-keys` (team).
- **Concurrency safety**: exclusive lock files via `open(..., 'wx')`.
- **State root**: project-local `.omp/state/` for everything persistent.

## External References (Perplexity sonar-pro, retrieved 2026-06-01)

Claude Code scheduling:
- https://code.claude.com/docs/en/scheduled-tasks (official)
- https://claudefa.st/blog/guide/development/scheduled-tasks
- https://www.mindstudio.ai/blog/claude-code-routines-scheduled-cloud-tasks/

Node schedulers / daemon patterns:
- https://blog.logrocket.com/comparing-best-node-js-schedulers/
- https://betterstack.com/community/guides/scaling-nodejs/best-nodejs-schedulers/
- https://blog.appsignal.com/2023/09/06/job-schedulers-for-node-bull-or-agenda.html

## Open Questions

- **Trigger surface**: should the agent register jobs from *inside* a Copilot session
  (a `/schedule` skill that shells out to `omp schedule add`), from the shell CLI, or
  both? (Repo convention per project memory: prefer `omp` CLI subcommands + hooks over
  MCP tools.)
- **Job scope**: per-project (`.omp/state/schedule/` in cwd) vs a user-global registry
  (`~/.omp/...`)? OS-scheduler entries are user-global, so cwd must be captured per job.
- **Which agent bin** is the scheduled default (`copilot` vs `claude`/`codex`/`gemini`)
  and how flags are passed for non-interactive, permission-bypassed runs.
- **Output delivery**: per-run log files only, or also notify (e.g. write to a team
  mailbox / append to a daily log) when a run finds something actionable?
- **Windows**: out of scope for v1 (research targeted macOS+Linux); Task Scheduler or the
  Option-A daemon would be the path if needed later.

## Related Research

- Project memory: `feedback_omp_cli_over_mcp.md` — for omp features prefer `omp` CLI
  subcommands + hooks over MCP tools (informs the trigger-surface question above).
