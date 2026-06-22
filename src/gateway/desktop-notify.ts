/**
 * Native desktop notifier — Hermes-style sibling of gateway/notify.ts. No daemon.
 * Each call is a one-shot, best-effort native OS notification via node-notifier
 * (cross-platform; on macOS it shells out to a vendored terminal-notifier).
 *
 * Contract (mirrors notify.ts): NEVER throws. Returns a structured result so the
 * caller (the schedule runner) can log a dropped notification to stderr without
 * the failure ever propagating into the job result.
 *
 * Deep-link: the `open` field is handed to the OS notification itself (URL or
 * file path opened on click). It is handled by the notification daemon, so it
 * survives the fire-and-exit cron process — unlike node-notifier's `click`
 * event, which would require keeping the process alive (`wait: true`).
 */

export interface DesktopNotifyOptions {
  title: string;
  message: string;
  /** URL or absolute file path to open when the notification is clicked. */
  open?: string;
}

/** Minimal slice of node-notifier we depend on (also the test seam). */
export interface Notifier {
  notify(opts: Record<string, unknown>, cb?: (err: Error | null) => void): void;
}

export interface DesktopNotifyDeps {
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override platform (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Inject the notifier (tests). Defaults to a lazily-loaded node-notifier. */
  notifier?: Notifier;
}

export type DesktopNotifyResult = { ok: true; skipped?: boolean } | { ok: false; reason: string };

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

  const title = (opts.title ?? "").trim();
  const message = (opts.message ?? "").trim();
  if (!title && !message) {
    return { ok: false, reason: "title and message are both empty" };
  }

  // Explicit kill-switch.
  if ((env.OMP_DISABLE_DESKTOP_NOTIFY ?? "").trim()) {
    return { ok: true, skipped: true };
  }

  // Headless Linux has no notification surface — skip rather than error.
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { ok: true, skipped: true };
  }

  try {
    const notifier = deps.notifier ?? (await loadNotifier());
    // Title/message are passed as data fields only (never as CLI args) — node-notifier
    // (>=9, CVE-2020-7789 fixed) escapes them. `open` is the OS-handled click target.
    const payload: Record<string, unknown> = { title: title || message, message, sound: false };
    if (opts.open) payload.open = opts.open;

    return await new Promise<DesktopNotifyResult>((resolve) => {
      try {
        notifier.notify(payload, (err) => {
          resolve(err ? { ok: false, reason: err.message } : { ok: true });
        });
      } catch (err) {
        resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Lazy-load node-notifier so non-notifying CLI paths never pay for the dependency. */
async function loadNotifier(): Promise<Notifier> {
  const mod = (await import("node-notifier")) as unknown as { default: Notifier } & Notifier;
  return mod.default ?? mod;
}
