# Plan: herdr (herdr-core `hc`) as the default agent backend, tmux as opt-out

Status: APPROVED v5 (critic OKAY on v4 conditional on 5 text fixes, applied in v5). History: (ralplan; v3 = critic fixes, v4 = architect-2 fixes: auto default, hashed names in
bash, non-retrying long `send`, env-file + absolute bin, explicit `--no-notify --outlive-parent`, core warm-up). v1 targeted the old `herdr` TUI CLI; the user pointed at https://herdr.dev,
whose product is **herdr-core (`hc`) + the Herdr desktop app**. The `herdr` CLI is now "the older
terminal multiplexer" (hc's own skill says: use `hc`, never `herdr`). v2 targets `hc`.

## Summary

The user wants **herdr as the default** for `/team`, `omp team`, the `omp` launcher and `omp comms`,
switchable to tmux via a config file in the home folder next to Copilot's config. herdr-core runs
programs in persistent, named terminals managed by a per-user core (auto-started by `hc`), which the
Herdr app shows as panes/sub-agents. tmux behavior stays byte-for-byte when tmux is selected.
No new npm dependencies; `hc` is an optional external binary like tmux.

## Verified `hc` facts (hc 0.1.17, isolated `HC_SESSION` + scratch XDG dirs, 2026-11-03)

- `hc run --bg --name N --cwd D [--label k=v]... -- <argv>` → JSON `{address:"t1",name,state:"live",...}`.
  The core **auto-starts** on first use (no server step). Names (verified message): "1-32 of a-z 0-9 - _ .
  starting with a letter or digit, not shaped like an id (t7)" — `a.b` accepted, `Abc`/`t7`/33 chars rejected; **unique among live terminals** (`name_taken`, exit 1) — an atomic duplicate guard.
  Invalid names → `invalid_params`, exit 6.
- **Terminals get the env of whoever auto-started the core, not the caller's** (critic-verified). If the Herdr
  app/launchd started the core, PATH may be minimal and `GH_TOKEN`/`GITHUB_TOKEN` stale. So every hc worker is
  launched through an **env file**, never env-in-argv (argv is world-readable via `ps`; tokens must not go there):
  the caller writes `<state>/hc-env/<name>.env` (mode 0600, dir 0700) with `PATH`, every `COPILOT_*`,
  `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, `GH_HOST` it has, plus `unset` lines for those keys it lacks,
  plus `OMP_TEAM_WORKER`/`OMP_MUX`; argv is
  `-- /bin/sh -c 'f=$1; shift; set -a; . "$f"; set +a; rm -f "$f"; exec "$@"' omp-env <file> <ABS_BIN> <args>`.
  The agent binary is resolved to an absolute path in the caller (`command -v` / `which`), so the core's PATH
  never decides which `omp`/`copilot` runs. Values are written shell-quoted (single-quote escaping), tested
  with quotes/newlines. The file is deleted by the worker on start; leftovers older than 1 h are swept on next launch.
- `hc send` can legitimately block: it waits for typing quiet (3 s, `HC_QUIET_MS`), protects a person's unsent
  draft up to 180 s (`DRAFT_MAX_MS`), and waits up to 5 s for young terminals' output to settle
  (herdr-core `input.rs:11-21,199-201,250,404`); it already does paste → 200 ms → Enter.
- `hc send T TEXT` = paste + Enter in one call. There is no "type without Enter".
  `hc keys T enter|esc|ctrl+c|ctrl+u|up|down` (key names, no tmux `C-m`).
- `hc read T --lines N` → text: visible screen (rows default 120) **plus** N history lines. Not "last N lines".
- `hc get T` → JSON with `state: live|finished`, `exit_code`, `labels`, `parent`. Killed/exited terminals
  stay `finished` until `hc rm T` (so "dead" is explicit, not "not found"). Unknown → exit 3 `not_found`.
- `hc ls --json` → `.terminals[]` (live only; `--all` adds finished). Labels are only in `hc get` output.
- `hc kill T`, `hc rm T`. Errors: JSON `{error:{kind,message,hint}}` on stderr; exit 3 not_found, 9 blocked, 11 finished.
- Children die with their parent terminal unless `--outlive-parent` / `--no-parent`.
- Agent status comes only from programs emitting OSC 7501. **Copilot CLI does not**, so `hc wait` /
  `send --wait` can't detect Copilot turns; we keep the existing screen-text readiness checks.
- Herdr app (`herdr-app`, desktop only): terminals started by an agent with `hc run` show as **sub-agents
  in the parent's tab**; `herdr-app do terminal.keep '{"terminal":"t7","place":"right"}'` gives one a pane.
  Terminals labeled `herdr.space=<id>`/`herdr.tab=<id>` appear in that space/tab.
- Inside an hc terminal: `HC_TERMINAL_ID` is set (verified: `$HC_TERMINAL_ID` = `t1`).
- Binary may be installed as `herdr-core` with `hc` symlinked only if no other `hc` exists → resolve
  `hc`, else `herdr-core`, and verify with `--version` output starting `hc `.

## Backend selection (one function, `src/team/mux.ts`; bash mirror in team-launch.sh)

1. `OMP_MUX=herdr|tmux` env (per-command override, also what we put in worker env files).
2. `<copilot home>/omp.json` → `{ "mux": "herdr" | "tmux" }`, where copilot home = `resolveCopilotPaths().userScope`
   (`src/copilot/paths.ts:54`, honors `COPILOT_HOME`, default `~/.copilot`); bash: `${COPILOT_HOME:-$HOME/.copilot}/omp.json`.
   We never write into Copilot's own `config.json`.
3. Default **auto**, which means herdr unless you are visibly in tmux:
   `HC_TERMINAL_ID` set ⇒ herdr; else `$TMUX` set ⇒ tmux (keeps visible split panes and loop-monitor for people
   already working in tmux); else ⇒ herdr. Config `"mux":"herdr"` forces herdr even inside tmux.
   (Architect-2 steelman; the launcher's "respect the current multiplexer" rule in S4 is the same rule.)
4. If the selected backend's binary is missing: herdr → fall back to tmux with a one-line stderr notice
   (`hc not found; using tmux. Install: https://herdr.dev or set "mux":"tmux" in ~/.copilot/omp.json`);
   tmux missing → current behavior (error / direct launch).
- `omp setup` prints the effective backend; `omp doctor` reports it and whether `hc`/tmux are found.
- **Per-team pinning (architect fix):** the backend chosen at start is stored in the team config / visual
  manifest; every later caller (`status`, `shutdown`, `api send-message`, `collect`, pane-monitor,
  comms) rebuilds the client from the stored value, never from the current env. Old configs without the
  field ⇒ tmux.

## Interface (architect fix: no more hiding herdr behind `TmuxApi`)

`src/team/pane-backend.ts` (new): a small backend-neutral interface the callers actually need:

```ts
interface PaneBackend {
  kind: "tmux" | "herdr";
  spawnWorker(o: { name: string; cwd: string; argv: string[]; env: Record<string,string>;
                   labels: Record<string,string>; group: string }): { ok: true; paneId: string } | { ok: false; error: string };
  submit(paneId: string, text: string): Promise<boolean>;   // tmux: existing sendToWorker; hc: `hc send`
  pressKey(paneId: string, key: "enter" | "ctrl+u" | "esc"): Result;
  read(paneId: string, lines: number): Result;             // returns at most the LAST `lines` lines
  alive(paneId: string): "alive" | "dead" | "unknown";      // unknown on timeout/core down: never "dead"
  closeGroup(group: string, paneIds: string[]): Result;
  groupExists(group: string): boolean;
}
```

- tmux implementation wraps the existing `makeTmux()` (no behavior change; `spawnWorker` = existing
  new-session/split + send bin + Enter).
- herdr implementation (`src/team/herdr.ts`): `hcExec(args, {timeoutMs})` (spawnSync, SIGKILL; default 10 s;
  `send`/`keys` 200 s, `run` 30 s) and `makeHerdrBackend()`. Before the first `run` in a process it calls
  `hc server status` once (30 s) so a cold core start never happens under a short kill timer. A timeout is
  always reported as `unknown` — **never retried** (a killed client does not cancel a request the core queued):
  - `spawnWorker` → `hc run --bg --json --no-parent --name <name> --cwd <cwd> --label omp.group=<group>
    --label omp.lane=<lane> --no-notify --outlive-parent -- <env-file launcher (above)> <ABS_BIN> <args>`; paneId = returned `address`. `--no-parent` so a
    runtime team survives the leader exiting (tmux sessions do too).
  - `submit` → one `hc send T text` (200 s). Exit 0 ⇒ true. Timeout/other error ⇒ false, no resend. Only if
    exit 0 **and** a following `read` proves the probe is still on the input line (shared pure
    `promptStillBuffered`, extracted from `tmux.ts`) do we press `hc keys T enter` once. No ctrl+u/retype
    fallback on herdr (hc already does paste→gap→Enter; retyping risks duplicate prompts). `pressKey` → `hc keys`; `read` → `hc read T --lines n`, trimmed to last n
    non-empty-tail lines; `alive` → `hc get T`: `live`⇒alive, `finished` or exit 3⇒dead, else unknown;
  - `closeGroup` → `hc kill` + `hc rm` each stored address (by address, never by label lookup);
  - `groupExists` → any live terminal named `<group>-*` (via `hc ls --json`).
- **One naming rule for TS and bash:** group = `omp-<hash6>` (first 6 hex of sha256 of the team/session name);
  worker/lane = `<group>-w<N>` (N = 1-based index). Always ≤ 32 chars, lowercase, never id-shaped. Full name stays
  in labels (`omp.team`, `omp.lane`) + config/manifest. bash computes hash6 with
  `printf %s "$SESSION" | sha256sum | cut -c1-6` (fallback `shasum -a 256` on macOS); a shared test asserts TS and
  bash produce identical names for fixed inputs. One `validHcName()` (`^[a-z0-9][a-z0-9._-]{0,31}$`, not
  `^t\d+[a-z]?$`) guards every call. Address regex used everywhere: `HC_ADDRESS_RE = /^t\d+[a-z]?$/`.
- `displayMessage` fallback in pane-monitor: on herdr, write the message via `submit` only if the leader is
  an hc terminal, else skip with a logged event (no silent drop).

## Slices (execution order; each independently verifiable)

### S1 — selection + config + `PaneBackend` (TS, no caller changes yet)
Files: `src/team/mux.ts`, `src/team/pane-backend.ts`, `src/team/herdr.ts`, `src/copilot/env-passthrough.ts`
(keep tmux `-e` passthrough as is), and `src/team/hc-env.ts` (new): the **single** env-file writer
(`writeHcEnvFile(env, extra) → path`, key list from S0 facts, shell-quoted, 0600 file / 0700 dir, `unset` lines for
absent keys, 1 h sweep) + `hcLaunchArgv(file, absBin, args)`. Exposed to bash as `omp team hc-env --out-json`
(prints `{file, argv}`), so quoting is implemented and tested once.
Verify: `test/team/mux.test.ts` (OMP_MUX > config file > auto: HC_TERMINAL_ID ⇒ herdr, $TMUX ⇒ tmux, else herdr;
missing hc ⇒ tmux + notice; malformed json ⇒ auto with warning; `COPILOT_HOME` respected),
`test/team/hc-env.test.ts` (values with `'`, `"`, `$`, newline round-trip through `/bin/sh`; modes 0600/0700;
`unset` for absent keys; worker deletes the file; sweep removes >1 h files only; no secret in returned argv),
`test/team/herdr.test.ts` (injected runner: exact argv with env-file launcher + absolute bin, `validHcName`,
`name_taken`, exit 6/9 handling (9 ⇒ unknown, no resend), alive mapping for live/finished/not_found/timeout,
read trimming, closeGroup, single `send` on timeout).

### S2 — runtime mode (`omp team`) on `PaneBackend`
Files: `src/team/runtime.ts`, `src/team/types.ts`, `src/team/api.ts`, `src/team/collect.ts`,
`src/team/pane-monitor.ts`, `src/team/idle-nudge.ts` (type only), `src/cli.ts` (team status text).
- `TeamConfig.mux?: { kind: "tmux" } | { kind: "herdr"; group: string }`; `tmuxSession` kept for tmux.
- Remove the `/(%\d+)/` parsing at `runtime.ts:120` in favor of `spawnWorker().paneId`.
- `runtime.ts:140` `C-m` → `Enter`.
- `backendFor(config)` used by every caller listed by the architect (`api.ts:152`, `collect.ts:116`,
  `pane-monitor.ts:139`, `cli.ts` status/shutdown).
- Loop-monitor / visual-registration identity checks remain tmux-only. `loop-monitor.ts` (`:123-145`
  validation, runtime target discovery) and `monitor-supervisor.ts` `hasLiveRuntimeTarget` (`:482`) **explicitly
  skip** configs with `mux.kind === "herdr"` before validation (no "invalid team config" diagnostic per tick).
  `omp team status` prints `monitor: unavailable on herdr`.
- Shutdown with no/corrupt config (`runtime.ts:337-348`): besides the conventional tmux session, when hc is
  available also kill+rm live hc terminals named `<omp-hash6(name)>-w*` (deterministic group name makes this possible).
- `omp team monitor-panes` (`cli.ts` ~`:2270-2300`, raw `--leader-pane/--worker-pane`): add `--mux herdr|tmux`;
  when absent infer from id shape (`%N` ⇒ tmux, `HC_ADDRESS_RE` ⇒ herdr; mixed ⇒ error).
Verify: extend `test/team/runtime.test.ts`, `test/team/api-messaging.test.ts`, `test/team/loop-monitor.test.ts`,
`test/team/pane-monitor.test.ts`, `test/cli.test.ts` (monitor-panes `--mux` + inference) with a fake hc runner:
herdr config skipped by loop-monitor with no diagnostic; config-less shutdown kills `<group>-w*`; start writes `mux.kind=herdr` + `w1..wN` addresses; shutdown kills+rms exactly those
addresses; worker `send-message` from an env saying tmux still uses herdr (pinning); legacy config ⇒ tmux;
core-down ⇒ lanes `unknown`, not `dead`.

### S3 — `/team` visual flow (`.github/skills/team/scripts/team-launch.sh`)
- Same selection rule in bash (`mux_backend()`: `$OMP_MUX`, then `jq -r .mux "${COPILOT_HOME:-$HOME/.copilot}/omp.json"`,
  then auto: `HC_TERMINAL_ID` ⇒ herdr, `$TMUX` ⇒ tmux, else herdr; fallback tmux + notice if no hc). tmux branch unchanged (keeps its `$TMUX` precondition).
- herdr branch: no `$TMUX` requirement. For each lane:
  `hc run --bg --json --name <omp-hash6(SESSION)>-w<N> --cwd "$CWD" --label omp.launch=$LAUNCH_ID --label omp.lane=$LANE_ID --no-notify --outlive-parent [--no-parent] -- <argv from omp team hc-env>`
  where the env file carries `OMP_TEAM_WORKER=1`, `OMP_MUX=herdr`, PATH, BYOK/auth keys, and argv ends with the
  absolute path of `omp` (`--madmax`) or `copilot` (`--yolo`). **No secret in argv.**
  Lane name = `<omp-hash6(SESSION)>-w<N>` (shared naming rule; `$SESSION` keeps its current 128-char validation).
  **Decision: always `--no-notify --outlive-parent`.** When inside hc (`HC_TERMINAL_ID` set) we keep the parent
  link (no `--no-parent`) so lanes show as sub-agents in the user's Herdr tab, but `--outlive-parent` so lanes
  survive the leader and `--no-notify` so hc never types notes into the leader's Copilot prompt (completion stays
  file-based via the delivery dir, same as tmux). If `herdr-app` is on PATH, also
  `herdr-app do terminal.keep '{"terminal":"<addr>","place":"right"}'` (best effort; warn on failure) for visible
  panes. Outside hc: add `--no-parent` and print `hc attach <name>` per lane.
- Readiness: poll `hc read <addr> --lines 25 | tail -n 25` for `/ commands`; trust dialog (`:148`, inside
  `wait_for_ready`) ⇒ `hc keys <addr> enter`.
- Prompt: `hc send <addr> "$LANE_PROMPT"` (one call; on non-zero exit print a warning and do not resend).
- Worker env: always via `omp team hc-env --out-json` (S1). If no control CLI is available (`CONTROL_CLI` empty),
  the herdr branch refuses with a clear message and suggests `OMP_MUX=tmux` (no second quoting implementation in bash).
- **Manifest schema stays a top-level array** (backward compatible); each lane gains optional
  `"mux": "herdr"|"tmux"` (missing ⇒ tmux) and `paneId` = hc address on herdr.
  `src/team/collect.ts` (`:44` `PANE_ID_RE`, `validLane`): accept `paneId` matching `%\d+` when lane mux is tmux and
  `HC_ADDRESS_RE` when lane mux is herdr; lanes in one manifest must share one mux (else reject); `collect` builds
  its liveness client from the lane mux (pinning source for visual teams). `register-visual` is skipped on herdr
  with one notice (tmux socket identity only).
- **Every tmux call in the script gets a herdr branch** (critic fix 3), via `mux_*` helpers:
  `select-layout tiled` (`:186`) and `select-pane '{left}'` (`:228`) → no-op on herdr; registration identity
  (`:243`) → skipped; trust-dialog Enter (`:148`) → `hc keys`; split/launch (`:170-181`) and prompt send
  (`:221-223`) → covered above; `pane_text` (`:129`) → `hc read A --lines N | tail -n N`; dead check (`:310`, `:350`)
  → `hc get A` state `finished` or exit 3; summary/hints (`:369` "Ctrl-b") → `hc attach <name>` hints.
Verify: `test/team/team-launch.test.ts` gets a fake `hc` on PATH (logs argv, returns canned JSON):
auto ⇒ herdr with no `$TMUX`, ⇒ tmux with `$TMUX`, config overrides; argv order run→read→send; the env file contains
`OMP_TEAM_WORKER=1` and the fake hc's logged argv contains no secret value; lane names equal the TS-computed names; **zero tmux invocations
anywhere on the herdr path, including monitor mode (without `--no-monitor`) and the summary** (fake `tmux` on PATH
that fails the test if called); manifest lanes carry `mux:"herdr"`; plus `test/team/collect.test.ts`: herdr manifest
with `t1`/`t2` collects; mixed-mux manifest rejected; legacy `%N` manifest unchanged;
`OMP_MUX=tmux` path keeps all existing assertions; missing hc ⇒ tmux path + notice.

### S4 — `omp` launcher on herdr
`src/copilot/launch.ts`: if inside a multiplexer (`HC_TERMINAL_ID` or `$TMUX`) ⇒ launch directly (no nesting).
Else if backend = herdr and TTY: `hc run --bg --no-parent --no-notify --name omp-<Date.now()> --cwd <cwd> -- <hcLaunchArgv(writeHcEnvFile(env), absBin, args)>`
then `spawn("hc", ["attach", name], {stdio:"inherit"})`; exit code = attach exit; after attach returns, if
`hc get` says `finished`, `hc rm` it (a detached, still-live session is left running); tell the user once that
Ctrl+\ detaches and the session keeps running. `OMP_FORCE_TMUX_WRAP=1` / `OMP_DISABLE_TMUX_WRAP=1` keep working
(force/disable apply to whichever backend; names kept for compat).
Verify: `test/copilot/launch.test.ts`: herdr default ⇒ `hc run` + `hc attach` spawned; inside hc ⇒ direct;
`mux: tmux` ⇒ existing tmux assertions.

### S5 — `omp comms` / Slack gateway on herdr
`src/comms/resolve-session.ts` + `src/comms/index.ts`: discovery also lists hc terminals named `omp-<digits>`
(launcher naming from S4) when backend = herdr; `--session` accepts an hc name/address. Send path uses
`submit`; read uses `read`. `COPILOT_TMUX_SESSION` still honored; add `COPILOT_SESSION` alias.
Verify: `test/comms-resolve.test.ts`, `test/comms.test.ts` with a fake hc backend: exactly-one discovery,
ambiguity error lists candidates, send/recv round trip, and a worker name like `omp-123456-w1` (all-digit hash6) is never discovered as a Copilot session.

### S6 — docs, skills, setup
- `.github/skills/team/SKILL.md`: herdr is default; prerequisites (`hc` from https://herdr.dev, Herdr app for
  visible panes); watch (`hc ls`, `hc attach <name>`), shutdown; how to switch: `~/.copilot/omp.json`
  `{"mux":"tmux"}` or `OMP_MUX=tmux`.
- README rows (team, comms, launcher) mention herdr default + tmux opt-out, plus a "Upgrading" note in README
  (no CHANGELOG.md exists; release notes go in the GitHub release body); `omp-autopilot` "(tmux panes)" →
  "(herdr/tmux)"; `omp setup` creates `~/.copilot/omp.json` only if absent (`{"mux":"herdr"}`), never overwrites.
- `npm run lint:skills` passes (lint.ts bans `tmux-only`; avoid that phrase).

## Acceptance criteria
1. With hc installed, no config, not inside tmux: `/team` with 3 lanes starts 3 hc terminals (named, labeled, cwd = repo),
   each gets its lane prompt with the delivery suffix, and `omp team collect --dir` reports allDone once result
   files exist. No tmux process is started.
2. `omp team 2:copilot "task" --name x` on herdr: config has `mux.kind=herdr` and two hc addresses;
   `omp team status x` lists both alive; `omp team shutdown x` kills+removes exactly those two, also when run with
   `OMP_MUX=tmux` in the env.
3. `~/.copilot/omp.json` `{"mux":"tmux"}` (or `OMP_MUX=tmux`) ⇒ every path behaves exactly as today
   (all existing tmux tests pass unchanged).
4. hc missing ⇒ tmux used, one notice printed, no crash.
5. BYOK/auth: `COPILOT_*`, `GH_TOKEN`/`GITHUB_TOKEN` and the caller's `PATH` reach herdr workers via a 0600 env
   file that the worker deletes; **no secret value appears in any hc argv** (asserted on the fake runner's argv);
   caller-absent keys are unset; the agent binary in argv is an absolute path.
5b. Auto selection: inside tmux with no config ⇒ tmux; inside hc ⇒ herdr; neither ⇒ herdr; config/env override both.
5c. TS and bash produce identical hc names for the same session/team name; all names pass `validHcName()`.
5d. A `send` timeout is never followed by a resend (fake runner times out once; assert one `send` call).
6. `omp` outside any multiplexer on herdr opens Copilot in an hc terminal and attaches; inside hc or tmux it
   launches directly.
7. `npm test`, `npm run lint`, `tsc` (strict), `npm run lint:skills` pass.

## Test shape
- Unit (vitest, injected runners): mux selection, hc adapter, runtime/api/collect pinning, launch, comms.
- Script test: fake `hc` binary on PATH for team-launch.sh (existing harness pattern).
- Integration (CI-optional, skipped when `hc` absent): real `hc` with `HC_SESSION=omp-test-<pid>` and scratch
  `XDG_*` dirs, stub worker `bash`; start → status → shutdown; `hc server stop` for that session only.
- Manual (user): real Copilot inside the Herdr app on macOS (`/team` 2 lanes visible as panes).

## Risks / tradeoffs
- **Auto default inside tmux = tmux.** A deliberate softening of "herdr by default": people already inside tmux
  keep visible panes + loop-monitor. Config `"mux":"herdr"` overrides. Flag to user for confirmation.
- **Polling vs hc-native signals (deferred, explicit):** hc parent notes / `send --wait` could replace the bash
  completion monitor, but Copilot doesn't emit OSC 7501 so `--wait` can't see Copilot turns. Follow-up S0':
  have omp's Copilot hooks emit OSC 7501 to the pane tty (unproven: hooks may not own the tty), then drop
  scraping on herdr. Until then lanes use `--no-notify` and file-based completion.
- **hc is v0.1.x** — CLI churn risk. Adapter parses only `address`, `state`, `exit_code`, `error.kind`;
  unknown shapes fail loudly. `omp doctor` prints hc version; document tested version 0.1.17.
- **No Copilot status in hc** (no OSC 7501) — we keep screen scraping. Follow-up: omp's Copilot hooks
  (`~/.copilot/hooks/omp.json`) could emit OSC 7501 so hc/Herdr show working/idle and `hc wait` works.
- **Monitoring parity deferred:** loop-monitor nudges for visual teams stay tmux-only (socket identity).
- **Default flips for existing users:** anyone with hc installed gets herdr on upgrade. Mitigated by the
  fallback, the config opt-out, the README "Upgrading" note + release notes, and `omp doctor`. (User asked for herdr default.)
- **Visible panes need the Herdr app**; outside it, workers are background terminals (`hc attach` to watch).
- **Env comes from the core's start, not the caller** — handled by the env file: PATH, `COPILOT_*`, GitHub auth
  keys, `OMP_TEAM_WORKER`, `OMP_MUX` come from the caller (absent ones unset). Only variables outside that list
  (e.g. `LANG`, proxy vars) still come from the core; documented, and the key list is one constant to extend.
  Secrets live briefly in a 0600 file deleted by the worker; a worker that never starts leaves it until the 1 h sweep.
- **Rejected:** targeting the old `herdr` TUI CLI (v1) — the product line moved to hc. **Rejected:**
  hiding hc behind `TmuxApi` (architect: silent pane-id/session/dead-pane mismatches).
  **Rejected:** writing our key into Copilot's own `~/.copilot/config.json` — Copilot owns and rewrites it.

## Ready for
`/team` or direct edits: S1 → S2 → (S3, S4 in parallel) → S5 → S6.

## Review (ralplan consensus record)
- Iteration 1: architect on v1 (old `herdr` TUI) → structural objections; plan retargeted to `hc` (v2) after user
  clarification; critic on v2 → REJECT (collect regex, manifest schema, unbranched tmux sites, monitor-panes, smaller items).
- Iteration 2: architect on v3 → ITERATE (auto default, hashed bash names, non-retrying long `send`, env/PATH/token
  handling, notify/outlive decision); critic on v4 → **OKAY** conditional on 5 mechanical text fixes, applied in v5.
- Review threads ran as Cloudroom child threads (claude-code), not `copilot --agent`, because `copilot` is not
  installed in this sandbox. Raw reviews: /tmp/arch-review.md, /tmp/critic-review-1.md, /tmp/arch-review-2.md,
  /tmp/critic-review-2.md (sandbox-only).

## Implementation notes (ralph, 2026-11-03) — deviations from v5, with reasons
1. **No separate `PaneBackend` interface.** The herdr client implements the existing `TmuxApi` contract plus
   `kind`, native `submit`, `spawnWorker`, `alive`, `closeGroup`; `sendToWorker` delegates to `submit`. The
   architect's concerns are still met: backend is pinned per team (`TeamConfig.mux`, manifest lane `mux`,
   `backendForConfig`), herdr start is an explicit branch (no `%N` parsing), tmux-only calls on herdr fail loudly
   (`newSession`/`splitWindow`/`sendText`), and timeouts/core-down never read as dead. Zero signature churn for callers.
2. **tmux start path kept byte-for-byte** (only `C-m` → `Enter`); `spawnWorker` exists only on herdr.
3. **`omp team hc-spawn` instead of `omp team hc-env --out-json`.** The bash launcher hands the whole spawn to the CLI,
   so the env file, absolute-binary resolution and hc flags are implemented once (TS) and bash never marshals argv.
4. **`omp setup` does not create `omp.json`.** A file with `{"mux":"herdr"}` would override auto and force herdr inside
   tmux, contradicting the auto rule. `omp doctor` reports the effective backend (`terminal-backend` check) instead.
5. **"hc not found" notice only when herdr was explicitly requested** (env/config). With auto, users without hc
   silently keep tmux; otherwise every `omp` launch would print it.
6. **`monitor-supervisor.hasLiveRuntimeTarget` unchanged:** herdr configs have no `tmuxIdentity`, so it already
   returns false for them; loop-monitor discovery got the explicit skip (mutation-tested).
7. **hc resolution is lazy** inside `makeHerdr`: a missing `hc` degrades per call (alive → unknown, errors) instead
   of throwing, so `collect`/`status` keep working — found by the real-hc end-to-end run.
