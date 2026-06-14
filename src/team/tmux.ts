import { spawnSync } from "node:child_process";
import { copilotEnvPassthroughArgs } from "../copilot/env-passthrough.js";

export interface TmuxResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type TmuxRunner = (args: string[]) => TmuxResult;

export function tmuxExec(args: string[]): TmuxResult {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

const PROMPT_RE = /(?:^|\s)(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯$#%]\s*$/;
const ACTIVE_HINTS = [
  /esc to interrupt/i,
  /esc cancel/i, // Copilot CLI >=1.0.61 working indicator ("◉ Working esc cancel")
  /[◉○◐◑]\s*working/i, // Copilot spinner + "Working"
  /running\s*[…\.]/,
  /background terminal/i,
  /tool call in progress/i,
];

// Lines the Copilot CLI renders below the actual prompt — skip these when
// scanning backwards for the real prompt character.
const STATUS_BAR_RE = /^\s*[\/ ]?\s*commands\b|^\s*[─━═]{3,}/;

export function paneLooksReady(captured: string): boolean {
  if (!captured.trim()) return false;
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
}

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
  };
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
