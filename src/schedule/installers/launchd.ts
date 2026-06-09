import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ScheduleJob } from "../types.js";

export function launchdLabel(id: string): string {
  return `com.omp.schedule.${id}`;
}

export function launchdPlistPath(id: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${launchdLabel(id)}.plist`);
}

export interface LaunchdSchedule {
  startInterval?: number;
  startCalendarInterval?: { Minute?: number; Hour?: number; Weekday?: number };
}

const STEP_EVERY_MIN = /^\*\/(\d+)$/;

/**
 * Translate a simple 5-field cron to a launchd schedule. Returns null for
 * patterns launchd's StartCalendarInterval cannot cleanly express (lists,
 * ranges, multi-step) — the caller then falls back to crontab.
 */
export function cronToLaunchdInterval(cron: string): LaunchdSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  // every N minutes: */N * * * *
  const minStep = STEP_EVERY_MIN.exec(min);
  if (minStep && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { startInterval: Number(minStep[1]) * 60 };
  }
  // every N hours: 0 */N * * *
  const hourStep = STEP_EVERY_MIN.exec(hour);
  if (min === "0" && hourStep && dom === "*" && mon === "*" && dow === "*") {
    return { startInterval: Number(hourStep[1]) * 3600 };
  }

  const isNum = (s: string) => /^\d+$/.test(s);
  // daily at H:M — minute & hour numeric, date/dow wild
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*" && dow === "*") {
    return { startCalendarInterval: { Minute: Number(min), Hour: Number(hour) } };
  }
  // weekly at H:M on a single weekday
  if (isNum(min) && isNum(hour) && dom === "*" && mon === "*" && isNum(dow)) {
    return { startCalendarInterval: { Minute: Number(min), Hour: Number(hour), Weekday: Number(dow) } };
  }
  return null;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function calendarXml(cal: NonNullable<LaunchdSchedule["startCalendarInterval"]>): string {
  const entries = Object.entries(cal)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `      <key>${k}</key>\n      <integer>${v}</integer>`)
    .join("\n");
  return `  <key>StartCalendarInterval</key>\n  <dict>\n${entries}\n  </dict>`;
}

/** Generate the LaunchAgent plist XML. Deliberately omits KeepAlive (timer jobs must not auto-restart). */
export function generatePlist(job: ScheduleJob, sched: LaunchdSchedule, logsDir: string, stateRoot: string): string {
  const label = launchdLabel(job.id);
  const outLog = join(logsDir, job.id, `${job.id}.launchd.out.log`);
  const errLog = join(logsDir, job.id, `${job.id}.launchd.err.log`);
  const scheduleXml =
    sched.startInterval !== undefined
      ? `  <key>StartInterval</key>\n  <integer>${sched.startInterval}</integer>`
      : calendarXml(sched.startCalendarInterval ?? {});
  // run from stateRoot and pass --root so state resolves correctly; the agent
  // subprocess cwd (job.cwd) is set by the runner, not by WorkingDirectory.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(job.ompBinPath)}</string>
    <string>schedule</string>
    <string>run</string>
    <string>--id</string>
    <string>${xmlEscape(job.id)}</string>
    <string>--root</string>
    <string>${xmlEscape(stateRoot)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(stateRoot)}</string>
${scheduleXml}
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function installLaunchd(job: ScheduleJob, sched: LaunchdSchedule, logsDir: string, stateRoot: string): void {
  const plistPath = launchdPlistPath(job.id);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(join(logsDir, job.id), { recursive: true });
  writeFileSync(plistPath, generatePlist(job, sched, logsDir, stateRoot), "utf8");
  try {
    execFileSync("launchctl", ["bootout", `${gui()}/${launchdLabel(job.id)}`], { stdio: "ignore" });
  } catch {
    // not loaded yet — fine
  }
  execFileSync("launchctl", ["bootstrap", gui(), plistPath], { stdio: "ignore" });
}

export function uninstallLaunchd(id: string): void {
  try {
    execFileSync("launchctl", ["bootout", `${gui()}/${launchdLabel(id)}`], { stdio: "ignore" });
  } catch {
    // already gone
  }
  const plistPath = launchdPlistPath(id);
  if (existsSync(plistPath)) unlinkSync(plistPath);
}

export function statusLaunchd(id: string): boolean {
  return existsSync(launchdPlistPath(id));
}
