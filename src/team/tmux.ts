import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { copilotEnvPassthroughArgs } from "../copilot/env-passthrough.js";

export interface TmuxResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type TmuxRunner = (args: string[]) => TmuxResult;

const TMUX_EXEC_TIMEOUT_MS = 3000;

export interface TmuxPaneContext {
  socketPath: string;
  serverPid: number;
  serverStartedAt: number;
  sessionId: string;
  sessionCreatedAt: number;
  windowId: string;
  paneId: string;
  currentPath: string;
  dead: boolean;
  launchId: string;
  laneId: string;
}

export function tmuxExec(args: string[]): TmuxResult {
  const r = spawnSync("tmux", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: TMUX_EXEC_TIMEOUT_MS,
  });
  const stderr = [r.stderr ?? "", r.error?.message ?? ""].filter(Boolean).join("\n");
  return {
    stdout: r.stdout ?? "",
    stderr,
    status: r.status ?? 1,
  };
}

const PROMPT_RE = /(?:^|\s)(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯$#%]\s*$/;
const ACTIVE_HINTS = [
  /esc to interrupt/i,
  /esc cancel/i, // Copilot CLI >=1.0.61 working indicator ("◉ Working esc cancel")
  /[◉○◐◑]\s*working/i, // Copilot spinner + "Working"
  /running\s*[….]/,
  /background terminal/i,
  /tool call in progress/i,
];

// Lines the Copilot CLI renders below the actual prompt — skip these when
// scanning backwards for the real prompt character.
const STATUS_BAR_RE = /^\s*[/ ]?\s*commands\b|^\s*[─━═]{3,}/;

// Copilot's TUI shows this idle footer ("/ commands · ? help") ONLY when it is
// waiting for input; while a task runs it shows a spinner / "esc to interrupt"
// instead (caught by ACTIVE_HINTS). Detecting the footer is robust to the
// input-box border rendering (block chars ╻▄┃╹▀) that breaks a bottom-up prompt
// scan — newer Copilot draws the box with blocks, not the ─━═ dashes above.
const READY_FOOTER_RE = /\bcommands\b.{0,24}\?\s*help/i;

export function paneLooksReady(captured: string): boolean {
  if (!captured.trim()) return false;
  if (READY_FOOTER_RE.test(captured)) return true;
  const lines = captured.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    if (STATUS_BAR_RE.test(line)) continue;
    return PROMPT_RE.test(line);
  }
  return false;
}

export function paneHasActiveTask(captured: string): boolean {
  return ACTIVE_HINTS.some((re) => re.test(captured));
}

export interface TmuxApi {
  newSession(session: string, cwd: string): TmuxResult;
  splitWindow(target: string, cwd: string): TmuxResult;
  sendKeys(target: string, ...keys: string[]): TmuxResult;
  sendText(target: string, text: string): TmuxResult;
  displayMessage(target: string, message: string): TmuxResult;
  capturePane(target: string, lines?: number): TmuxResult;
  killPane(target: string): TmuxResult;
  killSession(session: string): TmuxResult;
  paneDead(target: string): boolean;
  sessionExists(session: string): boolean;
  listSessions(): string[];
  paneContext?(target: string): TmuxPaneContext | undefined;
}

const PANE_CONTEXT_FORMAT = [
  "#{socket_path}",
  "#{pid}",
  "#{start_time}",
  "#{session_id}",
  "#{session_created}",
  "#{window_id}",
  "#{pane_id}",
  "#{pane_current_path}",
  "#{pane_dead}",
  "#{@omp_launch_uuid}",
  "#{@omp_lane_id}",
].join("|");

export function makeTmux(
  runner: TmuxRunner = tmuxExec,
  env: NodeJS.ProcessEnv = process.env,
): TmuxApi {
  // Forward COPILOT_* (BYOK) vars into worker panes; a running tmux server
  // otherwise seeds new panes from its own global env, so workers fall back to
  // GitHub-hosted models instead of the launcher's BYOK provider.
  const envArgs = copilotEnvPassthroughArgs(env);
  return {
    newSession(session, cwd) {
      return runner(["new-session", "-d", "-P", "-F", "#S:0 #{pane_id}", "-s", session, "-c", cwd, ...envArgs]);
    },
    splitWindow(target, cwd) {
      return runner(["split-window", "-h", "-t", target, "-d", "-P", "-F", "#{pane_id}", "-c", cwd, ...envArgs]);
    },
    sendKeys(target, ...keys) {
      return runner(["send-keys", "-t", target, ...keys]);
    },
    sendText(target, text) {
      return runner(["send-keys", "-t", target, "-l", "--", text]);
    },
    displayMessage(target, message) {
      return runner(["display-message", "-t", target, "--", message]);
    },
    capturePane(target, lines = 80) {
      return runner(["capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
    },
    killPane(target) {
      return runner(["kill-pane", "-t", target]);
    },
    killSession(session) {
      return runner(["kill-session", "-t", session]);
    },
    paneDead(target) {
      const r = runner(["display-message", "-t", target, "-p", "#{pane_dead}"]);
      return r.stdout.trim() === "1";
    },
    sessionExists(session) {
      const r = runner(["has-session", "-t", session]);
      return r.status === 0;
    },
    listSessions() {
      const r = runner(["list-sessions", "-F", "#{session_name}"]);
      if (r.status !== 0) return [];
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    },
    paneContext(target) {
      const result = runner([
        "display-message",
        "-t",
        target,
        "-p",
        PANE_CONTEXT_FORMAT,
      ]);
      if (result.status !== 0) return undefined;
      const parts = result.stdout.trimEnd().split("|");
      if (parts.length < 11) return undefined;
      const socketPath = parts[0]!;
      const serverPid = Number(parts[1]);
      const serverStartedAt = Number(parts[2]);
      const sessionId = parts[3]!;
      const sessionCreatedAt = Number(parts[4]);
      const windowId = parts[5]!;
      const paneId = parts[6]!;
      const currentPath = parts.slice(7, -3).join("|");
      const deadRaw = parts.at(-3);
      const launchId = parts.at(-2) ?? "";
      const laneId = parts.at(-1) ?? "";
      if (
        !socketPath ||
        !Number.isInteger(serverPid) ||
        !Number.isFinite(serverStartedAt) ||
        !sessionId ||
        !Number.isFinite(sessionCreatedAt) ||
        !windowId ||
        !paneId ||
        !currentPath ||
        (deadRaw !== "0" && deadRaw !== "1")
      ) {
        return undefined;
      }
      return {
        socketPath,
        serverPid,
        serverStartedAt,
        sessionId,
        sessionCreatedAt,
        windowId,
        paneId,
        currentPath,
        dead: deadRaw === "1",
        launchId,
        laneId,
      };
    },
  };
}

export function makeTmuxForSocket(
  socketPath: string,
  runner: TmuxRunner = tmuxExec,
  env: NodeJS.ProcessEnv = process.env,
): TmuxApi {
  if (!isAbsolute(socketPath)) {
    throw new Error("tmux socket path must be absolute");
  }
  return makeTmux((args) => runner(["-S", socketPath, ...args]), env);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// waitForReady — poll a pane until the Copilot CLI is idle at its input
// prompt, auto-accepting the folder-trust dialog if it appears.
// ---------------------------------------------------------------------------

const TRUST_RE = /Do you trust/;
const CLI_READY_RE = /\/\s*commands/;

export interface WaitForReadyOptions {
  /** Max time to wait in ms (default 60 000). */
  timeoutMs?: number;
  /** Poll interval in ms (default 2 000). */
  pollMs?: number;
}

/**
 * Block until the Copilot CLI in `target` pane is ready for input.
 * Returns `true` if ready, `false` on timeout.
 */
export async function waitForReady(
  api: TmuxApi,
  target: string,
  options: WaitForReadyOptions = {},
): Promise<boolean> {
  const timeout = options.timeoutMs ?? 60_000;
  const poll = options.pollMs ?? 2_000;
  let elapsed = 0;
  let acceptedTrust = false;

  while (elapsed < timeout) {
    const captured = api.capturePane(target, 25).stdout;

    // Ready: the '/ commands' status bar means the CLI input prompt is active
    if (CLI_READY_RE.test(captured)) return true;

    // Auto-accept the folder trust dialog (send Enter = accept default).
    // Use the `Enter` key name: Copilot CLI (>=1.0.61) ignores a literal `C-m`.
    if (!acceptedTrust && TRUST_RE.test(captured)) {
      api.sendKeys(target, "Enter");
      acceptedTrust = true;
    }

    await sleep(poll);
    elapsed += poll;
  }
  return false;
}

export interface SendToWorkerOptions {
  rounds?: number;
  delayMs?: number;
}

/**
 * True if `probe` still sits on the active input line (the last prompt-glyph
 * line plus any wrapped continuation). Checks the input region only — not the
 * whole scrollback — so the echo of an already-submitted message is not
 * mistaken for a still-buffered prompt.
 */
function promptStillBuffered(pane: string, probe: string): boolean {
  const lines = pane.split(/\r?\n/);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("❯")) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;
  return lines.slice(idx).join("\n").includes(probe);
}

export async function sendToWorker(
  api: TmuxApi,
  target: string,
  text: string,
  options: SendToWorkerOptions = {},
): Promise<boolean> {
  const rounds = options.rounds ?? 6;
  const delayMs = options.delayMs ?? 150;
  const payload = text.length > 200 ? text.slice(0, 200) : text;
  const probe = payload.slice(-Math.min(20, payload.length));
  api.sendText(target, payload);
  for (let i = 0; i < rounds; i++) {
    // Use the `Enter` key name: Copilot CLI (>=1.0.61) ignores a literal `C-m`,
    // leaving the prompt buffered and unsent.
    api.sendKeys(target, "Enter");
    await sleep(delayMs);
    // Submitted once the prompt leaves the input line (the echo in scrollback
    // does not count, so we never retype an already-sent message).
    if (!promptStillBuffered(api.capturePane(target, 5).stdout, probe)) return true;
  }
  // adaptive fallback: kill-line, retype, submit once more
  api.sendKeys(target, "C-u");
  await sleep(delayMs);
  api.sendText(target, payload);
  api.sendKeys(target, "Enter");
  return true;
}
