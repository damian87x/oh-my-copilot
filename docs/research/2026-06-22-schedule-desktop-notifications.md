---
date: 2026-06-22T13:40:00+01:00
researcher: Damian Borek
git_commit: 4044437
branch: main
repository: oh-my-copilot
topic: "Native desktop notifications on scheduled-job completion (feature-request assessment)"
tags: [research, codebase, scheduling, cron, notifications, launchd, slack, gateway, daily-log]
status: complete
last_updated: 2026-06-22
last_updated_by: Damian Borek
---

# Research: Desktop notifications on `omp schedule` job completion

**Date**: 2026-06-22 13:40 +0100
**Researcher**: Damian Borek
**Git Commit**: 4044437
**Branch**: main
**Repository**: oh-my-copilot

## Research Question

Assess the feature request: after a scheduled `omp` job finishes, fire a **native, cross-platform (macOS-first) desktop notification** containing the job name, success/failed status, and a one-line output summary (e.g. `Dependabot: C:0 H:6 M:8 L:0 — 14 alerts`). Verify (a) the schedule system actually works, (b) whether such a notification would be a **modular / opt-in** option, and (c) how job results + full output + the daily log are wired so a notification could later deep-link back into `omp`.

> Per the user's explicit "check this feature request" ask, this document maps the
> current system factually **and** includes a clearly-marked feasibility section at the
> end. The "Detailed Findings" sections describe only what exists today.

---

## Summary

- **The schedule system exists and is wired end-to-end.** `src/schedule/` implements a durable, OS-backed scheduler: `commands.ts` (add/list/status/remove/run-now), `runner.ts` (spawn + capture + persist), `installer.ts` + `installers/{launchd,systemd,crontab}.ts` (OS triggers), `job-store.ts` / `paths.ts` (state), plus the `/schedule` skill front-end. It is exercised by 5 test files under `test/schedule/`. This matches Option C ("hybrid JSON store + OS scheduler + locked run handler") proposed in the 2026-06-01 research doc.
- **A post-run notification hook already exists — but it is Slack-only.** `ScheduleJob.notifyTarget` ([types.ts:48](src/schedule/types.ts)) is an optional field; when set, `runScheduledJob` posts a one-line summary to Slack via `gateway/notify.ts` after each completed run ([runner.ts:180-196](src/schedule/runner.ts)). It is **off by default** (opt-in via `--notify-target`), validated to accept **only `slack:` targets** ([target-parser.ts:92](src/gateway/target-parser.ts), [cli.ts:1455-1462](src/cli.ts)), and failures **never break the job** (logged to stderr only).
- **No native desktop-notification code exists anywhere.** A scan for `osascript`, `node-notifier`, `terminal-notifier`, `notify-send`, PowerShell toast, `NSUserNotification`, `display notification` across `src/`, `scripts/`, and `package.json` returns **zero hits**. The only notification transport in the repo is the Slack REST POST in `gateway/notify.ts`.
- **The notification payload the request wants already exists at the call site.** At [runner.ts:187](src/schedule/runner.ts) the runner has `job.id`, `result.status` (`ok`/`error`/`timeout`/`locked`/`expired`), and `result.summary` (first ~200 chars of stdout/stderr) in hand — exactly the "name / status / one-line summary" the request asks for. Today it formats them as `[schedule] <id>: <status> (<summary>)` and sends to Slack.
- **Full output + results + daily-log are three distinct stores:**
  - Per-run **full output** → `.omp/state/schedule/logs/<id>/<timestamp>.log` (the `result.logPath`).
  - Per-run **result line** (ts, exitCode, status, summary, logPath, durationMs) → `.omp/state/schedule/results/<id>.jsonl` (append-only).
  - **Surfacing into the next session** → the `SessionStart` hook reads unseen result lines via a byte-offset cursor and injects a `[SCHEDULE RESULTS]` banner ([scripts/lib/schedule-results.mjs](scripts/lib/schedule-results.mjs)). This is the existing "show me the latest dependabot scan" deep-link substrate.
  - The **daily log** (`.omp/memory/daily/<date>.md`, [src/daily-log.ts](src/daily-log.ts)) is a *separate* manual mechanism (`omp daily-log add/read`); the scheduler does **not** write to it automatically.

**Bottom line for the request:** the modular, opt-in notification *seam* is already built and proven (Slack). A desktop notification is a **new transport behind the same `notifyTarget` seam**, not a new subsystem. There is currently no native-OS notification code to reuse.

---

## Detailed Findings

### A. The schedule run lifecycle — where the notification fires

`runScheduledJob(job, paths, opts)` ([src/schedule/runner.ts:47](src/schedule/runner.ts)) executes one tick:

1. **Expiry/max-runs check** before any spawn → may persist an `expired` result and call `opts.onExpire` ([runner.ts:71-83](src/schedule/runner.ts)).
2. **Overlap lock** (`.omp/state/schedule/jobs/<id>.lock`) so two ticks never run the same job concurrently ([runner.ts:86-106](src/schedule/runner.ts)).
3. **Spawn the agent** (`spawn(bin, ["--model", m, "-p", prompt, "--allow-all-tools"?], {cwd})`), capture stdout/stderr, enforce `timeoutMs` with SIGTERM→SIGKILL escalation, write the `.log`, rotate to newest 50 ([runner.ts:108-168](src/schedule/runner.ts)).
4. **Persist** the result (append JSONL + update job's `lastRunAt`/`lastStatus`/`lastSummary`/`lastLogPath`) ([runner.ts:56-68, 170](src/schedule/runner.ts)).
5. **Release the lock**, then **best-effort notify** ([runner.ts:174-196](src/schedule/runner.ts)).

The notify block is the precise integration point for the request:
```ts
// runner.ts:180-196
if (job.notifyTarget) {
  const notify = opts.notify ?? (async (text, target) => {
    const { notify: realNotify } = await import("../gateway/notify.js");
    const r = await realNotify({ text, target });
    return r.ok ? { ok: true } : { ok: false, reason: `${r.code}: ${r.reason}` };
  });
  const summary = `[schedule] ${job.id}: ${result.status} (${result.summary})`;
  const r = await notify(summary, job.notifyTarget);
  if (!r.ok) process.stderr.write(`schedule: notify failed for ${job.id}: ${r.reason ?? "unknown"}\n`);
}
```
Notes: the lock is released **before** notify so a slow transport can't make the next cron tick see `locked` ([runner.ts:171-175](src/schedule/runner.ts)); the `notify` impl is injectable via `opts.notify` for tests ([runner.ts:18](src/schedule/runner.ts)); any failure or throw is swallowed to stderr ([runner.ts:188-195](src/schedule/runner.ts)).

### B. The notification seam is modular + opt-in by construction

- **Field**: `ScheduleJob.notifyTarget?: string` ([types.ts:42-48](src/schedule/types.ts)) and `ScheduleAddOptions.notifyTarget?: string` ([types.ts:73-74](src/schedule/types.ts)). Optional → **default off**.
- **CLI flag**: `--notify-target` parsed at [cli.ts:1455](src/cli.ts), validated by `parseTarget` *before* the job is written ([cli.ts:1456-1462](src/cli.ts)); invalid target → `add` fails fast.
- **Stored verbatim** onto the job at [commands.ts:89](src/schedule/commands.ts) (`notifyTarget: opts.notifyTarget`).
- **Help text** already advertises it: `... [--notify-target slack:<ID>] ...` ([cli.ts:42](src/cli.ts) help block).
- The `/schedule` SKILL.md does **not** yet mention `--notify-target` ([.github/skills/schedule/SKILL.md](.github/skills/schedule/SKILL.md)) — the flag is wired in the CLI but not surfaced in the skill steps.

### C. Target grammar — today only `slack:` is accepted

`parseTarget(raw)` ([src/gateway/target-parser.ts:77](src/gateway/target-parser.ts)) splits `"<platform>:<ref>"` and **rejects any platform other than `slack`**:
```ts
// target-parser.ts:92-94
if (platform !== "slack") {
  return { ok: false, error: `unsupported platform "${platform}"; only "slack" today` };
}
```
The file header explicitly notes telegram/discord/feishu are "slice 2+" and Slack is "slice 1". So a `desktop:` (or similar) scheme would currently be rejected at `add` time. `notify()` in `gateway/notify.ts` is likewise Slack-specific (POST to `chat.postMessage`, requires `SLACK_BOT_TOKEN`).

### D. Cross-platform OS scheduler — verified to target macOS first

Backend selection ([installer.ts:22-28](src/schedule/installer.ts)):
- `darwin` → **launchd** (the macOS-first path the request targets).
- else if `systemctl --user` works → **systemd**.
- else → **crontab**.

**launchd path** ([installers/launchd.ts](src/schedule/installers/launchd.ts)):
- Label `com.omp.schedule.<id>`; plist at `~/Library/LaunchAgents/com.omp.schedule.<id>.plist`.
- `cronToLaunchdInterval` maps simple crons to `StartInterval` (every-N-min/hour) or `StartCalendarInterval` (daily/weekly at H:M); anything richer (lists/ranges) returns `null` → **falls back to crontab** ([installer.ts:50-58](src/schedule/installer.ts)).
- Each tick runs: `<ompBinPath> schedule run --id <id> --root <stateRoot>` ([launchd.ts:89-98](src/schedule/installers/launchd.ts)).
- `ompBinPath` resolved via `OMP_BIN` env → `which omp` → `process.argv[1]` ([commands.ts:29-39](src/schedule/commands.ts)).
- Install = write plist + `launchctl bootout` (ignore failure) + `launchctl bootstrap gui/$UID <plist>` ([launchd.ts:115-126](src/schedule/installers/launchd.ts)); idempotent. Uninstall = bootout + delete plist ([launchd.ts:128-136](src/schedule/installers/launchd.ts)).

This confirms the OS entry invokes the same `omp schedule run` handler that contains the notify block — i.e. **desktop notifications would fire from the launchd-spawned process**, in the user's GUI session (relevant: a launchd *LaunchAgent* runs in the user's GUI domain, which is what desktop notifications require).

### E. Results, full output, and session surfacing (the deep-link substrate)

On-disk layout under `.omp/state/schedule/` ([paths.ts](src/schedule/paths.ts)):
- `jobs/<id>.json` — the portable source of truth (all `ScheduleJob` fields incl. `lastSummary`/`lastLogPath`).
- `jobs/<id>.lock` — overlap lock.
- `results/<id>.jsonl` — append-only `ScheduleRunResult` lines (`ts, exitCode, status, summary, logPath, durationMs`) ([job-store.ts:51-54](src/schedule/job-store.ts)).
- `results/<id>.offset` — byte-offset "seen" cursor ([paths.ts:41-43](src/schedule/paths.ts)).
- `logs/<id>/<timestamp>.log` — **full** per-run stdout/stderr (the `result.logPath`), newest 50 kept ([runner.ts:31-44, 112, 152](src/schedule/runner.ts)).
- `logs/<id>/<id>.launchd.{out,err}.log` — launchd's own stdio ([launchd.ts:75-76](src/schedule/installers/launchd.ts)).

Surfacing into the next agent session ([scripts/lib/schedule-results.mjs](scripts/lib/schedule-results.mjs), called from [scripts/session-start.mjs:54-55](scripts/session-start.mjs)): on `SessionStart` it scans every `results/*.jsonl` from each job's cursor, emits up to 10 lines as:
```
[SCHEDULE RESULTS]
- <id> @ <ts>: <status> — <summary up to 100 chars>
```
then advances the cursor so each result is shown once. This is exactly the context that lets a later "show me the latest dependabot scan" prompt resolve — the summary points at the job id, and the full log lives at the `logPath` recorded on the result/job.

### F. The daily log is separate and manual

`src/daily-log.ts` maintains `.omp/memory/daily/<YYYY-MM-DD>.md` with `## Goal` / `## Log` sections, exposed via `omp daily-log set-goal|add|read|prune` ([cli.ts:42](src/cli.ts) help). The scheduler does **not** call into it — there is no code path from `runner.ts` to `daily-log.ts`. Any "results referenced in the daily log" today happens because the agent (seeing the `[SCHEDULE RESULTS]` banner) chooses to write them there, not automatically.

### G. Test coverage of the schedule path

`test/schedule/`: `commands.test.ts`, `installer.test.ts`, `job-store.test.ts`, `lock.test.ts`, `runner.test.ts` (plus `test/scripts/session-start-schedule.test.ts` for the banner). The `runner.test.ts` exercising of the injectable `opts.notify` is what makes the notify seam unit-testable without a live transport.

---

## Feasibility Assessment (explicit "check this feature request" ask)

**What the request maps onto, concretely:**

1. **Modular / opt-in?** Yes, natively. The `notifyTarget` field + `--notify-target` flag are already the opt-in seam (default off, validated at `add`). A desktop notification fits as **a new target scheme behind the same seam** rather than a new subsystem.
2. **What's missing today:**
   - A native notification transport (macOS-first). The repo has **none** — no `osascript`/`terminal-notifier`/`node-notifier`. A new transport module (sibling to `gateway/notify.ts`) plus a dispatch decision in the runner's notify block would be required.
   - `parseTarget` rejects all non-`slack:` platforms ([target-parser.ts:92](src/gateway/target-parser.ts)); a `desktop:`-style scheme (or a sentinel like `--notify-desktop`) would need to be accepted there or routed before `parseTarget`.
3. **Payload** — already available verbatim at the call site (`job.id`, `result.status`, `result.summary`) ([runner.ts:187](src/schedule/runner.ts)); the "Dependabot: C:0 H:6 M:8 L:0 — 14 alerts" line is just whatever the scheduled prompt prints, truncated to ~200 chars.
4. **macOS delivery context** — launchd LaunchAgents run in the user's GUI domain ([launchd.ts:111-126](src/schedule/installers/launchd.ts)), which is the domain that can post user notifications; systemd `--user` / crontab runs may not have a GUI session attached, which is the cross-platform caveat to flag.
5. **"Brownie points" on-click deep-link** — the substrate exists (result `summary` + `logPath` + the `[SCHEDULE RESULTS]` SessionStart banner), but there is **no** click-handler / URL-scheme / app-open wiring in the repo today; that would be net-new and OS-specific (notifications that survive to carry a click action typically need a helper like `terminal-notifier -execute`, since `osascript display notification` cannot attach a click action).

---

## Code References

- `src/schedule/runner.ts:180-196` — the post-run notify block (integration point).
- `src/schedule/runner.ts:147-164` — where `result.status` + `result.summary` (the payload) are produced.
- `src/schedule/types.ts:42-48,73-74` — `notifyTarget` on `ScheduleJob` / `ScheduleAddOptions` (opt-in field).
- `src/cli.ts:1455-1462` — `--notify-target` parse + validate in `schedule add`.
- `src/cli.ts:1430-1521` — full `handleScheduleCommand` dispatch.
- `src/schedule/commands.ts:89` — `notifyTarget` stored onto the job.
- `src/gateway/target-parser.ts:92-94` — `slack`-only platform gate.
- `src/gateway/notify.ts:74-157` — Slack REST notifier (the only transport).
- `src/schedule/installer.ts:22-66` — OS backend detect + install.
- `src/schedule/installers/launchd.ts:73-126` — macOS plist + `omp schedule run` argv + launchctl.
- `scripts/lib/schedule-results.mjs:37-88` — `[SCHEDULE RESULTS]` SessionStart banner + cursor.
- `scripts/session-start.mjs:54-55` — where the banner is injected.
- `src/schedule/job-store.ts` / `src/schedule/paths.ts` — results JSONL, cursor, log paths.
- `src/daily-log.ts` — separate manual daily log (`.omp/memory/daily/<date>.md`).
- `.github/skills/schedule/SKILL.md` — `/schedule` front-end (does not yet mention `--notify-target`).
- `test/schedule/{commands,installer,job-store,lock,runner}.test.ts` — schedule coverage.

## Architecture Documentation (patterns observed)

- **Notification seam**: optional `notifyTarget` on the job → best-effort, lock-released, failure-isolated call after persist. Transport is pluggable via `opts.notify` (tested) but production-resolves to one hardcoded Slack importer.
- **Target grammar**: `"<platform>:<ref>"`, single-platform (`slack`) today, explicitly designed for future "slices".
- **OS trigger**: per-OS backend, launchd preferred on macOS, with a crontab fallback when launchd can't express the cron; each entry re-invokes `omp schedule run --id <id> --root <dir>`.
- **State**: project-local `.omp/state/schedule/{jobs,results,logs}/`; append-only results + byte-cursor "seen" tracking; full output in rotated per-run `.log` files.
- **Surfacing**: SessionStart hook banner, not a push — the daily log is a separate, manually-driven store.

## Historical Context (from docs/research/)

- `docs/research/2026-06-01-schedule-cron-feature.md` — the original design study. Its Option C (JSON store + OS scheduler + locked run handler) is what shipped. Its **Open Questions** explicitly listed *"Output delivery: per-run log files only, or also notify … when a run finds something actionable?"* — this feature request is the direct continuation of that open question. It also flagged Windows as out-of-scope for v1.

## Related Research

- `docs/research/2026-06-01-schedule-cron-feature.md`

## Open Questions

- **Scheme vs flag**: surface desktop notifications as a `notifyTarget` scheme (e.g. `desktop:`) routed before/around `parseTarget`, or as a separate boolean flag — and can a job have *both* Slack and desktop targets at once (current field is a single string)?
- **Transport choice on macOS**: `osascript -e 'display notification'` (no deps, no click action) vs a bundled/optional `terminal-notifier` (supports `-execute` click actions, the "brownie points" path) vs `node-notifier` (a new dependency).
- **Cross-platform delivery context**: systemd `--user` and crontab ticks may run without an attached GUI session; does the feature degrade gracefully (skip + stderr) off-macOS?
- **Deep-link target**: on click, what does "opens omp and shows the latest scan" invoke — a tmux send-keys into a running `omp` session, a fresh `omp -p "show me the latest <id> result"`, or just opening the `logPath`?
- **SKILL.md surfacing**: `--notify-target` is wired in the CLI but absent from the `/schedule` skill steps; would a desktop option need the skill updated too?
