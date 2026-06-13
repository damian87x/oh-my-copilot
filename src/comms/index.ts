/**
 * comms — a thin wrapper that lets you talk to a running Copilot CLI session
 * over tmux: send a prompt in, read the reply back, and check whether Copilot
 * is reachable first.
 *
 * Design notes:
 * - Reuses the tmux primitives in `../team/tmux.ts` (no new tmux plumbing).
 * - Every external dependency (tmux, connectivity probe, sleep) is injectable
 *   so the logic is unit-testable without a real tmux server or network.
 * - A send is gated on two conditions, mirroring "connected to the internet
 *   AND on": the target tmux session must exist, and an internet reachability
 *   probe must succeed. If either fails the send is refused with a structured
 *   error (never a silent no-op).
 */
import { createConnection } from "node:net";
import {
  makeTmux,
  paneLooksReady,
  paneHasActiveTask,
  type TmuxApi,
} from "../team/tmux.js";

/**
 * Strip ANSI escape sequences (OSC, CSI, and single-char Fe) from pane text.
 * The OSC branch is bounded — it stops at the next BEL or ESC and tolerates a
 * missing terminator (capture-pane can truncate mid-sequence) so it never
 * greedily consumes real output between two sequences.
 */
export function stripAnsi(input: string): string {
  // OSC: ESC ] ... up to BEL or ST (optional, to tolerate truncation).
  // eslint-disable-next-line no-control-regex
  const osc = /\][^]*(?:|\\)?/g;
  // CSI: ESC [ params intermediates final; or a single-char Fe escape.
  // eslint-disable-next-line no-control-regex
  const csiFe = /(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
  return input.replace(osc, "").replace(csiFe, "");
}

// --- connectivity --------------------------------------------------------

export interface OnlineOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
}

/** Low-level reachability probe: resolves true if a TCP connection opens. */
export type Connector = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const defaultConnector: Connector = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/**
 * Returns true when the host appears to have internet connectivity. Defaults
 * to a TCP probe of 1.1.1.1:443; overridable via env or options for tests and
 * restricted networks.
 *
 * Note: this confirms reachability of the probe host only, not that Copilot's
 * upstream (GitHub / model API) is reachable. It is a coarse "are we online"
 * gate, not a Copilot health check.
 */
export async function checkOnline(
  opts: OnlineOptions = {},
  connect: Connector = defaultConnector,
): Promise<boolean> {
  const host = opts.host ?? process.env.OMP_NET_PROBE_HOST ?? "1.1.1.1";
  const port = opts.port ?? (Number(process.env.OMP_NET_PROBE_PORT) || 443);
  const timeoutMs = opts.timeoutMs ?? (Number(process.env.OMP_NET_PROBE_TIMEOUT_MS) || 3000);
  try {
    return await connect(host, port, timeoutMs);
  } catch {
    return false;
  }
}

// --- shared deps ---------------------------------------------------------

export interface CommsDeps {
  /** tmux API (defaults to the real one). */
  tmux?: TmuxApi;
  /** internet reachability check (defaults to {@link checkOnline}). */
  isOnline?: () => Promise<boolean>;
  /** sleep used by polling loops (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- status --------------------------------------------------------------

export interface StatusResult {
  ok: true;
  session: string;
  /** tmux session exists ("on"). */
  exists: boolean;
  /** internet reachable. */
  online: boolean;
  /** pane shows an idle prompt (ready for input). */
  ready: boolean;
  /** pane shows an active task in progress. */
  busy: boolean;
  /** set when the pane existed but its contents could not be read. */
  error?: string;
}

export async function commsStatus(session: string, deps: CommsDeps = {}): Promise<StatusResult> {
  const tmux = deps.tmux ?? makeTmux();
  const exists = tmux.sessionExists(session);
  const online = deps.isOnline ? await deps.isOnline() : await checkOnline();
  let ready = false;
  let busy = false;
  let error: string | undefined;
  if (exists) {
    const cap = tmux.capturePane(session, 40);
    if (cap.status !== 0) {
      // Session is "on" but unreadable — surface it rather than reporting a
      // misleading running-but-idle state.
      error = `failed to read copilot pane (tmux exit ${cap.status})`;
    } else {
      const captured = stripAnsi(cap.stdout);
      ready = paneLooksReady(captured);
      busy = paneHasActiveTask(captured);
    }
  }
  return { ok: true, session, exists, online, ready, busy, ...(error ? { error } : {}) };
}

// --- send ----------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  session?: string;
  /** true if the text was observed in the pane before Enter was pressed. */
  confirmed?: boolean;
  /** true if the prompt was observed to leave the input buffer (actually submitted). */
  submitted?: boolean;
  error?: string;
}

export interface SendOptions {
  /** send even when the pane shows an active task in progress. */
  force?: boolean;
}

/**
 * True if the active input line (the last prompt line) still holds `probe`.
 * Distinguishes a buffered-but-unsent prompt from a submitted one: after submit
 * the trailing prompt line is empty and `probe` only survives in scrollback.
 */
function inputLineHasProbe(pane: string, probe: string): boolean {
  const lines = pane.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.includes("❯") || /^\s*>/.test(line)) return line.includes(probe);
  }
  return false;
}

/**
 * Send a prompt into the Copilot pane. Refuses unless the session exists AND
 * the host is online. Sends the text literally, then presses Enter (C-m) and
 * verifies the prompt actually left the input buffer.
 *
 * Before pressing Enter it confirms the text landed in the input buffer by
 * comparing pane captures (a delta check, so prompt text already present in
 * scrollback can't false-confirm). Copilot CLI (>=1.0.61) can absorb a C-m
 * that arrives immediately after a bracketed paste, leaving the prompt
 * buffered and unsent; so after Enter we verify the input line cleared and
 * re-send Enter up to twice if it did not. Submission is detected by the input
 * line emptying or the host going busy, so a successful send is never
 * double-submitted.
 */
export async function commsSend(
  session: string,
  text: string,
  deps: CommsDeps = {},
  opts: SendOptions = {},
): Promise<SendResult> {
  if (!text || !text.trim()) {
    return { ok: false, error: "empty message" };
  }
  if (/[\r\n]/.test(text)) {
    // send-keys delivers embedded newlines literally, which most TUIs treat as
    // separate submissions — refuse rather than mis-submit a multi-line prompt.
    return { ok: false, error: "multi-line prompts are not supported; send a single line" };
  }
  const tmux = deps.tmux ?? makeTmux();
  if (!tmux.sessionExists(session)) {
    return { ok: false, error: `copilot session not running: ${session}` };
  }
  const online = deps.isOnline ? await deps.isOnline() : await checkOnline();
  if (!online) {
    return { ok: false, error: "offline: no internet connectivity" };
  }
  // Read the pane once: doubles as a failure check and a busy-gate baseline.
  const pre = tmux.capturePane(session, 5);
  if (pre.status !== 0) {
    return { ok: false, error: `failed to read copilot pane (tmux exit ${pre.status})` };
  }
  const baseline = stripAnsi(pre.stdout);
  if (!opts.force && paneHasActiveTask(baseline)) {
    // Don't inject a prompt while Copilot is mid-response — pass force to override.
    return { ok: false, error: "copilot is busy (task in progress); retry or use --force" };
  }
  const sleep = deps.sleep ?? defaultSleep;
  const probe = text.slice(-Math.min(20, text.length));
  const probeInBaseline = baseline.includes(probe);
  const sent = tmux.sendText(session, text);
  if (sent.status !== 0) {
    return { ok: false, error: `tmux send-keys failed (exit ${sent.status})` };
  }
  // Confirm the literal text landed in the input buffer before pressing Enter,
  // rather than relying on a fixed delay. Best-effort: send Enter once after
  // the confirm window regardless, so we never double-submit.
  let confirmed = false;
  for (let i = 0; i < 6; i++) {
    const cap = stripAnsi(tmux.capturePane(session, 5).stdout);
    // If the probe wasn't already on screen, its appearance confirms the send.
    // If it was, require the pane to have changed (the new text was appended).
    if (cap.includes(probe) && (!probeInBaseline || cap !== baseline)) {
      confirmed = true;
      break;
    }
    await sleep(50);
  }
  // Press Enter, then verify the prompt actually left the input buffer.
  // Copilot CLI (>=1.0.61) ignores a literal `C-m` carriage return but honors
  // the tmux `Enter` key name; sending `C-m` leaves the prompt buffered and
  // unsent. Settle first, then re-send if the input line still holds the text.
  let submitted = false;
  for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
    await sleep(attempt === 0 ? 250 : 400);
    const enter = tmux.sendKeys(session, "Enter");
    if (enter.status !== 0) {
      return { ok: false, error: `tmux send-keys Enter failed (exit ${enter.status})` };
    }
    for (let i = 0; i < 6; i++) {
      const cap = stripAnsi(tmux.capturePane(session, 5).stdout);
      // Submitted if the host started working or the input line no longer holds the prompt.
      if (paneHasActiveTask(cap) || !inputLineHasProbe(cap, probe)) {
        submitted = true;
        break;
      }
      await sleep(100);
    }
  }
  return { ok: true, session, confirmed, submitted };
}

// --- recv ----------------------------------------------------------------

export interface RecvOptions {
  /** number of trailing pane lines to capture (default 80). */
  lines?: number;
  /** poll until the pane returns to an idle prompt before capturing. */
  wait?: boolean;
  /** max time to wait when `wait` is set (default 30000ms). */
  timeoutMs?: number;
  /** poll interval when `wait` is set (default 500ms). */
  pollMs?: number;
}

export interface RecvResult {
  ok: boolean;
  session?: string;
  text?: string;
  /** true if `wait` gave up before the pane became ready (text may be mid-generation). */
  timedOut?: boolean;
  error?: string;
}

/** Read Copilot's latest pane output back (ANSI-stripped). */
export async function commsRecv(
  session: string,
  deps: CommsDeps = {},
  opts: RecvOptions = {},
): Promise<RecvResult> {
  const tmux = deps.tmux ?? makeTmux();
  if (!tmux.sessionExists(session)) {
    return { ok: false, error: `copilot session not running: ${session}` };
  }
  const lines = opts.lines ?? 80;
  let timedOut = false;
  if (opts.wait) {
    const sleep = deps.sleep ?? defaultSleep;
    const timeoutMs = opts.timeoutMs ?? 30000;
    const pollMs = opts.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    timedOut = true;
    while (Date.now() < deadline) {
      const snapshot = stripAnsi(tmux.capturePane(session, lines).stdout);
      if (paneLooksReady(snapshot) && !paneHasActiveTask(snapshot)) {
        timedOut = false;
        break;
      }
      await sleep(pollMs);
    }
  }
  const captured = tmux.capturePane(session, lines);
  if (captured.status !== 0) {
    return { ok: false, error: `failed to read copilot pane (tmux exit ${captured.status})` };
  }
  const text = stripAnsi(captured.stdout);
  return { ok: true, session, text, ...(opts.wait ? { timedOut } : {}) };
}

// --- ask (send + wait + isolate the new reply) ---------------------------

/** A line that is only whitespace, box-drawing, or a bare prompt glyph. */
// eslint-disable-next-line no-misleading-character-class
const PROMPT_ONLY = /^[\s│┃║▌▐▏▕╎┆┊›>❯$#%]*$/;

/**
 * Best-effort isolation of the output that appeared *after* a baseline capture.
 * tmux scrollback has no reliable delimiters, so this uses an order-preserving
 * multiset diff: lines present in `after` but not already accounted for in
 * `before` are treated as new, with leading/trailing blank or prompt-only lines
 * trimmed. It is a heuristic — not a guaranteed exact reply boundary.
 */
export function newOutputSince(before: string, after: string): string {
  const norm = (s: string) => s.split("\n").map((l) => l.replace(/\s+$/, ""));
  const counts = new Map<string, number>();
  for (const line of norm(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of norm(after)) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
      continue;
    }
    out.push(line);
  }
  while (out.length && (!out[0]!.trim() || PROMPT_ONLY.test(out[0]!))) out.shift();
  while (out.length && (!out[out.length - 1]!.trim() || PROMPT_ONLY.test(out[out.length - 1]!))) {
    out.pop();
  }
  return out.join("\n");
}

export interface AskOptions extends SendOptions {
  /** trailing pane lines to consider (default 200). */
  lines?: number;
  /** max time to wait for Copilot to go idle (default 30000ms). */
  timeoutMs?: number;
  /** poll interval while waiting (default 500ms). */
  pollMs?: number;
}

export interface AskResult extends RecvResult {
  /** whether the prompt was actually sent. */
  sent: boolean;
}

/**
 * Send a prompt and return only Copilot's new reply: snapshot the pane, send
 * (with the same on/online/busy guards as {@link commsSend}), wait until the
 * pane goes idle, then diff against the snapshot via {@link newOutputSince}.
 */
export async function commsAsk(
  session: string,
  text: string,
  deps: CommsDeps = {},
  opts: AskOptions = {},
): Promise<AskResult> {
  const tmux = deps.tmux ?? makeTmux();
  if (!tmux.sessionExists(session)) {
    return { ok: false, error: `copilot session not running: ${session}`, sent: false };
  }
  const lines = opts.lines ?? 200;
  const pre = tmux.capturePane(session, lines);
  if (pre.status !== 0) {
    return { ok: false, error: `failed to read copilot pane (tmux exit ${pre.status})`, sent: false };
  }
  const baseline = stripAnsi(pre.stdout);
  const sent = await commsSend(session, text, deps, { force: opts.force });
  if (!sent.ok) {
    return { ok: false, error: sent.error, sent: false };
  }
  const recv = await commsRecv(session, deps, {
    wait: true,
    lines,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
  });
  if (!recv.ok) {
    return { ok: false, error: recv.error, sent: true };
  }
  return {
    ok: true,
    session,
    text: newOutputSince(baseline, recv.text ?? ""),
    timedOut: recv.timedOut,
    sent: true,
  };
}
