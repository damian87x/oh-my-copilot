/**
 * Deep-link target for a scheduled run's desktop notification.
 *
 * node-notifier's `open` field is opened by the OS notification daemon on click,
 * so it survives the fire-and-exit cron process. We resolve it to one of:
 *   - the raw per-run log file (`file://<logPath>`) — the default, cross-platform; or
 *   - (macOS + notifyOpenOmp) a generated `.command` launcher that opens an
 *     interactive `omp` in the job's cwd; the SessionStart `[SCHEDULE RESULTS]`
 *     banner then surfaces the latest run — i.e. "opens omp ready to engage".
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** POSIX single-quote escaping: wrap in '…', closing/escaping any embedded quote. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The launcher script body: cd into the job cwd and exec an interactive omp. */
export function buildOpenOmpScript(cwd: string, ompBinPath: string): string {
  return `#!/bin/sh\ncd ${shellQuote(cwd)} && exec ${shellQuote(ompBinPath)}\n`;
}

/** Write the executable launcher into the job's log dir; return its absolute path. */
export function writeOpenOmpLauncher(logDir: string, cwd: string, ompBinPath: string): string {
  const launcherPath = join(logDir, "open-omp.command");
  writeFileSync(launcherPath, buildOpenOmpScript(cwd, ompBinPath), { mode: 0o755 });
  return launcherPath;
}

export interface OpenTargetInput {
  platform: NodeJS.Platform;
  notifyOpenOmp: boolean;
  logDir: string;
  logPath: string;
  cwd: string;
  ompBinPath: string;
}

/**
 * Resolve the notification's click target. The "open omp" launcher is macOS-only
 * (it relies on `.command` files opening in Terminal); everywhere else we fall
 * back to opening the raw run log.
 */
export function resolveOpenTarget(input: OpenTargetInput): string {
  if (input.notifyOpenOmp && input.platform === "darwin") {
    const launcher = writeOpenOmpLauncher(input.logDir, input.cwd, input.ompBinPath);
    return pathToFileURL(launcher).href;
  }
  return pathToFileURL(input.logPath).href;
}
