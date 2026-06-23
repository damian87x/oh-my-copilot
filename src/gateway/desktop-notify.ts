/**
 * Native desktop notifier — Hermes-style sibling of gateway/notify.ts. No daemon.
 * Each call is a one-shot, best-effort native OS notification.
 *
 * Platform transports (the bundled node-notifier terminal-notifier does NOT
 * display on modern macOS — it is an unsigned app run from node_modules — so we
 * do not use it there):
 *   - macOS: `osascript display notification` by default — the only path that
 *     reliably DISPLAYS on macOS Sequoia. It cannot carry a click action. A
 *     system `terminal-notifier` (which supports the click `-open` deep-link)
 *     is used only when OMP_NOTIFY_USE_TERMINAL_NOTIFIER is set, since it does
 *     not display on some Sequoia builds.
 *   - Linux/Windows: node-notifier (notify-send / SnoreToast).
 *
 * Contract (mirrors notify.ts): NEVER throws. Returns a structured result so the
 * caller (the schedule runner) can log a dropped notification to stderr without
 * the failure ever propagating into the job result. A bounded timeout means a
 * wedged backend can never hang `omp schedule run`; the osascript/terminal-notifier
 * children are our own and are killed on timeout.
 */
import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface DesktopNotifyOptions {
  title: string;
  message: string;
  /** URL or absolute file path to open when the notification is clicked (click-capable transports only). */
  open?: string;
}

/** Resolved, non-empty payload handed to a transport. */
export interface ResolvedPayload {
  title: string;
  message: string;
  open?: string;
}

/** Minimal slice of node-notifier we depend on (also a test seam). */
export interface Notifier {
  notify(opts: Record<string, unknown>, cb?: (err: Error | null) => void): void;
}

/** Low-level command runner (test seam). Never throws; returns the structured result. */
export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<DesktopNotifyResult>;

/** A delivery transport (test seam — bypasses platform selection entirely). */
export type Transport = (payload: ResolvedPayload, timeoutMs: number) => Promise<DesktopNotifyResult>;

export interface DesktopNotifyDeps {
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Max wait for delivery before giving up. Default 15s. */
  timeoutMs?: number;
  /** Inject the full transport (tests) — bypasses platform selection. */
  transport?: Transport;
  /** Inject the command runner (tests) for the macOS transports. */
  exec?: ExecFn;
  /** Inject system-terminal-notifier availability (tests). Defaults to a PATH lookup. */
  hasSystemTerminalNotifier?: boolean;
  /** Inject node-notifier (tests) for the non-macOS transport. */
  notifier?: Notifier;
}

export type DesktopNotifyResult = { ok: true; skipped?: boolean } | { ok: false; reason: string };

/**
 * Bound on how long we wait for delivery (a hung backend must not stall cron).
 * Kept comfortably above node-notifier's own ~10s display timeout so a slow but
 * successful delivery is not misclassified as a timeout.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Build the argv for `osascript`. The message/title are passed as `argv` items
 * (via `on run argv`), never interpolated into the AppleScript source, so an
 * arbitrary run summary cannot inject AppleScript.
 */
export function buildOsascriptArgs(title: string, message: string): string[] {
  return [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    "--",
    message,
    title,
  ];
}

/**
 * Fire a desktop notification. Library entry point — never throws.
 * Skips silently (ok:true, skipped) when disabled or on a headless host.
 */
export async function notifyDesktop(
  opts: DesktopNotifyOptions,
  deps: DesktopNotifyDeps = {},
): Promise<DesktopNotifyResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  // Skips win first — a disabled/headless host produces no artifact and no error.
  if ((env.OMP_DISABLE_DESKTOP_NOTIFY ?? "").trim()) {
    return { ok: true, skipped: true };
  }
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { ok: true, skipped: true };
  }

  const title = (opts.title ?? "").trim();
  const message = (opts.message ?? "").trim();
  if (!title && !message) {
    return { ok: false, reason: "title and message are both empty" };
  }

  const payload: ResolvedPayload = { title: title || message, message, open: opts.open };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const transport = deps.transport ?? selectTransport(platform, deps);
    return await withTimeout(() => transport(payload, timeoutMs), timeoutMs);
  } catch (err) {
    return { ok: false, reason: errMsg(err) };
  }
}

/** Pick the delivery transport for this host. */
function selectTransport(platform: NodeJS.Platform, deps: DesktopNotifyDeps): Transport {
  const exec = deps.exec ?? realExec;
  if (platform === "darwin") {
    // Default to osascript: it is the one path that reliably displays on macOS
    // Sequoia. A system terminal-notifier (which supports the click `-open`
    // deep-link) is used ONLY when explicitly opted in, because it does not
    // display on some Sequoia builds — preferring it would silently break
    // notifications. See OMP_NOTIFY_USE_TERMINAL_NOTIFIER.
    const env = deps.env ?? process.env;
    const optIn = Boolean((env.OMP_NOTIFY_USE_TERMINAL_NOTIFIER ?? "").trim());
    const tnCommand = optIn ? resolveTerminalNotifier(deps) : null;
    return (payload, timeoutMs) => deliverMac(payload, exec, tnCommand, timeoutMs);
  }
  return (payload, timeoutMs) => deliverNodeNotifier(payload, deps, timeoutMs);
}

/** The terminal-notifier command to exec (validated absolute path), or null to use osascript. */
function resolveTerminalNotifier(deps: DesktopNotifyDeps): string | null {
  if (deps.hasSystemTerminalNotifier !== undefined) {
    return deps.hasSystemTerminalNotifier ? "terminal-notifier" : null;
  }
  return detectSystemTerminalNotifier();
}

/** macOS: osascript displays reliably (no click); opt-in terminal-notifier adds the click `-open`. */
function deliverMac(p: ResolvedPayload, exec: ExecFn, tnCommand: string | null, timeoutMs: number): Promise<DesktopNotifyResult> {
  if (tnCommand) {
    const args = ["-title", p.title, "-message", p.message, ...(p.open ? ["-open", p.open] : [])];
    return exec(tnCommand, args, timeoutMs);
  }
  return exec("osascript", buildOsascriptArgs(p.title, p.message), timeoutMs);
}

/** Non-macOS: node-notifier (notify-send / SnoreToast), bounded by the outer timeout. */
async function deliverNodeNotifier(p: ResolvedPayload, deps: DesktopNotifyDeps, _timeoutMs: number): Promise<DesktopNotifyResult> {
  const notifier = deps.notifier ?? (await loadNotifier());
  const opts: Record<string, unknown> = { title: p.title, message: p.message, sound: false };
  if (p.open) opts.open = p.open;
  return new Promise<DesktopNotifyResult>((resolve) => {
    try {
      notifier.notify(opts, (err) => resolve(err ? { ok: false, reason: err.message } : { ok: true }));
    } catch (err) {
      resolve({ ok: false, reason: errMsg(err) });
    }
  });
}

/** Race a delivery against a bounded timeout. The timer stays referenced so it fires. */
function withTimeout(fn: () => Promise<DesktopNotifyResult>, timeoutMs: number): Promise<DesktopNotifyResult> {
  return new Promise<DesktopNotifyResult>((resolve) => {
    let settled = false;
    const done = (r: DesktopNotifyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: `desktop notify timed out after ${timeoutMs}ms` }), timeoutMs);
    Promise.resolve()
      .then(fn)
      .then(done, (err) => done({ ok: false, reason: errMsg(err) }));
  });
}

/** Real command runner: execFile with its own kill-on-timeout (our child, we own it). */
const realExec: ExecFn = (file, args, timeoutMs) =>
  new Promise<DesktopNotifyResult>((resolve) => {
    execFile(file, args, { timeout: Math.max(1_000, timeoutMs) }, (err) => {
      resolve(err ? { ok: false, reason: (err.message || String(err)).slice(0, 200) } : { ok: true });
    });
  });

/** True only when neither the PATH entry nor its real (symlink-resolved) target is under node_modules. */
export function isSystemNotifierPath(resolved: string, real: string): boolean {
  if (!resolved) return false;
  const hasNodeModules = (p: string): boolean => p.split(/[\\/]/).includes("node_modules");
  return !hasNodeModules(resolved) && !hasNodeModules(real);
}

/**
 * Resolve a SYSTEM terminal-notifier to its validated absolute path, or null.
 * Resolves the symlink target too, so a PATH symlink pointing at node-notifier's
 * bundled copy is rejected (it does not display on Sequoia and isn't "system").
 */
function detectSystemTerminalNotifier(): string | null {
  try {
    const resolved = execFileSync("which", ["terminal-notifier"], { encoding: "utf8" }).trim();
    if (!resolved) return null;
    let real = resolved;
    try {
      real = realpathSync(resolved);
    } catch {
      // keep `resolved` if the realpath lookup fails
    }
    return isSystemNotifierPath(resolved, real) ? real : null;
  } catch {
    return null;
  }
}

/** Lazy-load node-notifier so non-notifying CLI paths never pay for the dependency. */
async function loadNotifier(): Promise<Notifier> {
  const mod = (await import("node-notifier")) as unknown as { default: Notifier } & Notifier;
  return mod.default ?? mod;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
