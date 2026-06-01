import { execFileSync } from "node:child_process";
import { cronToLaunchdInterval, installLaunchd, statusLaunchd, uninstallLaunchd } from "./installers/launchd.js";
import { installCrontab, statusCrontab, uninstallCrontab } from "./installers/crontab.js";
import { installSystemd, statusSystemd, uninstallSystemd } from "./installers/systemd.js";
import type { OsBackend, ScheduleJob } from "./types.js";

export interface DetectOptions {
  platform?: NodeJS.Platform;
  hasSystemctl?: boolean;
}

function systemctlAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Pick the native backend for this host. Inputs are injectable for testing. */
export function detectOsBackend(opts: DetectOptions = {}): OsBackend {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return "launchd";
  const hasSystemctl = opts.hasSystemctl ?? systemctlAvailable();
  if (hasSystemctl) return "systemd";
  return "crontab";
}

export interface InstallResult {
  backend: OsBackend;
  installed: boolean;
}

/**
 * Install the OS-scheduler entry for a job. On launchd, a cron expression that
 * StartCalendarInterval cannot express falls back to crontab — the chosen
 * backend is returned so the caller can persist it on the job.
 */
export function installJob(
  job: ScheduleJob,
  logsDir: string,
  stateRoot: string,
  opts: DetectOptions = {},
): InstallResult {
  const backend = detectOsBackend(opts);
  // Replace semantics: clear any prior entry for this id first.
  uninstallJob(job.id, backend);

  if (backend === "launchd") {
    const sched = cronToLaunchdInterval(job.cron);
    if (sched === null) {
      // launchd can't express this cron — fall back to crontab.
      installCrontab(job, logsDir, stateRoot);
      return { backend: "crontab", installed: true };
    }
    installLaunchd(job, sched, logsDir, stateRoot);
    return { backend: "launchd", installed: true };
  }
  if (backend === "systemd") {
    installSystemd(job, stateRoot);
    return { backend: "systemd", installed: true };
  }
  installCrontab(job, logsDir, stateRoot);
  return { backend: "crontab", installed: true };
}

/** Uninstall by the job's recorded backend. Idempotent — never throws if absent. */
export function uninstallJob(id: string, backend: OsBackend): void {
  try {
    if (backend === "launchd") uninstallLaunchd(id);
    else if (backend === "systemd") uninstallSystemd(id);
    else uninstallCrontab(id);
  } catch {
    // best effort — entry may already be gone
  }
}

export function getInstalledStatus(id: string, backend: OsBackend): boolean {
  try {
    if (backend === "launchd") return statusLaunchd(id);
    if (backend === "systemd") return statusSystemd(id);
    return statusCrontab(id);
  } catch {
    return false;
  }
}
