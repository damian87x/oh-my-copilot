# Design: Team messaging (worker↔worker / worker↔leader) + nudge gating

> Status: **Design only — no implementation yet.** Target repo: `oh-my-copilot`.
> Date: 2026-05-29

## 1. Problem & evidence

Two related gaps in `src/team`:

**A. Workers cannot message anyone.** The entire `team api` surface (`src/cli.ts:35`) is:

- `team api claim-task`
- `team api transition-task-status`

There is **no `send-message`, `broadcast`, or mailbox** anywhere in `src`. The only
worker→lead signal is an outbox line auto-appended on task transition
(`src/team/api.ts:55-65`), consumed by the monitor (`readNewOutbox`). So a worker
cannot ask the lead a question, hand off to a peer, or nudge a teammate. This is the
"teams says limitation can't message" behavior.

This must work **without MCP** (Copilot CLI; MCP is disabled in the target org). The
existing design is already file + CLI based, so this is the natural fit.

**B. Nudge is ungated.** `NudgeTracker` runs only inside `monitorTeam`
(`src/team/runtime.ts:224`) and is **default-on** (`:213`). `monitorTeam` is not yet
wired into any command, so nudge effectively never fires today — but when it is wired
in, default-on would nudge every monitored team run (including read-only polling).
Desired: **off by default, but ON for `/team` orchestration runs and for active
ralph/loop modes.** Plain read-only polling (`team status`) and library/one-shot use
stay quiet.

## 2. What already exists (reuse, don't rebuild)

- `state-paths.ts` already defines `mailboxDir` (`.omp/state/team/<team>/mailbox`) and
  `dispatchDir`, and `ensureTeamDirs` already creates them. Workers already have
  `inboxFile` (`workers/<name>/inbox.md`), `outboxFile`, `heartbeatFile`, pane id in
  config (`Worker.paneId`).
- `tmux.ts` exposes `sendToWorker(api, paneId, text, …)` — the nudge transport.
- `outbox.ts` has a robust byte-cursor JSONL reader we can mirror for mailbox reads.

## 3. Feature A — messaging

### 3.1 Data model

New file `src/team/mailbox.ts`. One JSONL file per recipient:
`.omp/state/team/<team>/mailbox/<recipient>.jsonl`, plus a `.<recipient>.offset` cursor
(mirror `outbox.ts`). `leader` is the reserved recipient name for the lead.

```ts
export interface MailboxMessage {
  id: string;          // uuid
  from: string;        // worker name or "leader"
  to: string;          // worker name or "leader"
  body: string;
  timestamp: string;   // ISO
  deliveredAt?: string;
}
```

Functions: `appendMailbox`, `readNewMailbox`/`peekMailbox` (cursor-based),
`listMailbox`, `markDelivered`.

### 3.2 API surface (additions to `src/team/api.ts` + `cli.ts`)

- `team api send-message --input '{team_name, from, to, body, cwd?}'`
  → validates `to` is `leader` or a registered worker (`config.workers`), rejects
  unknown recipients with `unknown_recipient` (no phantom mailbox), appends to the
  recipient mailbox, then **nudges the recipient pane** (see 3.3).
- `team api broadcast --input '{team_name, from, body, cwd?}'`
  → fans out to **every worker except `from`, PLUS the `leader` mailbox**.
  Reuses oh-my-claudecode's mechanism (`teamBroadcast`, `team-ops.ts:604`: loop
  recipients → `send` to each), but oh-my-claudecode skips the lead (it only iterates
  `cfg.workers`); here we additionally append `leader` to the recipient set so the lead
  receives broadcasts too. Sender is always excluded (no self-message, no echo loop).
- `team api mailbox-list --input '{team_name, worker, cwd?}'` → list (optionally
  undelivered only).
- `team api mailbox-mark-delivered --input '{team_name, worker, message_id, cwd?}'`.

All pure file ops, callable directly in tests (no MCP, no tmux required for persistence).

### 3.3 Delivery / nudge

After persisting, look up the recipient's `paneId` from `config.workers` (or
`leader_pane_id` in config). If present and a tmux session is live, call
`sendToWorker(...)` with a short trigger. If no pane (worker not spawned / headless
test), persistence still succeeds — delivery is pull-based via `mailbox-list`.
**Nudge-on-send reuses the same `sendToWorker` transport, independent of the
idle-`NudgeTracker`.**

**Throttle/coalesce — reuse what already exists, build nothing new:**
- The idle `NudgeTracker` (`idle-nudge.ts`) already carries the same throttle as
  oh-my-claudecode (`scanIntervalMs: 5000`, `maxCount: 3`) — unchanged.
- For send-nudge, mirror oh-my-claudecode's `generateMailboxTriggerMessage(count)`:
  the trigger states the **unread count** (`listMailbox(...).filter(!deliveredAt).length`)
  — "N new msg(s): read your mailbox …". Multiple messages arriving before the worker
  reads simply raise the count in the next poke rather than spamming distinct triggers.
  No separate coalescing/debounce machinery.

### 3.4 Worker overlay (`worker-bootstrap.ts buildInboxMarkdown`)

Add a "Messaging" section teaching workers they may message the **lead OR any teammate**:

```
omp team api send-message --input '{"team_name":…,"from":"<me>","to":"leader","body":"…"}' --json
omp team api send-message --input '{"team_name":…,"from":"<me>","to":"<teammate>","body":"…"}' --json
omp team api mailbox-list   --input '{"team_name":…,"worker":"<me>"}' --json
```

State that the recipient is auto-nudged, and that unknown names return `unknown_recipient`.

### 3.5 Tests (Vitest, file-based, no MCP)

`test/team/mailbox.test.ts` + `test/team/api.messaging.test.ts`:
worker→leader, worker→peer, broadcast-excludes-sender, mailbox-list/mark-delivered,
unknown-recipient rejection, cursor advance. A nudge unit test mocks `tmux`/`sendToWorker`
to assert the recipient pane is poked.

## 4. Feature B — nudge gating

Change `monitorTeam` so nudge is **off by default**, but **ON for `/team`
orchestration runs and active ralph/loop modes**:

- Default `opts.nudge?.enabled` to **`false`** (flip current `!== false`).
- Add `resolveNudgeEnabled(opts, cwd)` → `true` when ANY of:
  1. `opts.nudge?.enabled === true` — set by the **`/team` command's monitor loop**
     (the orchestration spawn+monitor path in `cli.ts` passes `nudge:{enabled:true}`).
     This is what makes nudge ON for `/team`.
  2. A loop-mode state file is active: `readRalph(cwd)?.active`, or the equivalent
     `ultrawork`/`ultraqa` state (modes live at `.omp/state/<mode>.json`,
     `src/mode-state/paths.ts`).
  3. Falls back to `false` otherwise.
- Add a small `isLoopModeActive(cwd)` helper in `mode-state` (reads the three mode
  files) so condition 2 is one source of truth.

Result:
- **`/team` orchestration** → nudge ON (condition 1).
- **ralph / ultrawork / ultraqa loops** → nudge ON (condition 2).
- **Read-only `team status` / library one-shot use** → nudge OFF (no `enabled:true`,
  no active loop mode).

### Tests

`test/team/runtime.test.ts` additions: nudge off by default; ON when `enabled:true`
(the `/team` path); ON when a ralph/loop mode state is active; OFF when neither signal
is present (e.g. `team status` polling).

## 5. Build sequence

1. `mailbox.ts` + tests (red→green).
2. `api.ts` messaging fns + `cli.ts` wiring + tests.
3. `worker-bootstrap.ts` overlay docs + test.
4. Nudge gating in `runtime.ts` + `mode-state` helper + tests.
5. Update `.github/skills/team/SKILL.md` to document messaging + nudge gating.

## 6. Out of scope (YAGNI)

- No dispatch-queue/retry state machine (the richer oh-my-claudecode design) — pull-based
  mailbox + best-effort nudge is enough here.
- No leader registered as a team member; `leader` stays a reserved mailbox name.
- No cross-team messaging.

## 7. Resolved decisions

- **Broadcast reaches workers AND the lead** (every worker except sender + the `leader`
  mailbox). Extends oh-my-claudecode's workers-only `teamBroadcast`.
- **Nudge throttling reuses existing mechanisms** (idle `NudgeTracker` scan/maxCount +
  an unread-count in the send trigger, mirroring `generateMailboxTriggerMessage`).
  No new debounce/coalesce layer.
- **Nudge gating:** off by default; ON for `/team` orchestration runs and active
  ralph/ultrawork/ultraqa loop modes.
