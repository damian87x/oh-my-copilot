import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scheduleRunArgv } from "./invocation.js";
import type { ScheduleJob } from "../types.js";

export function unitBaseName(id: string): string {
  return `omp-schedule-${id}`;
}

function userUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

export function servicePath(id: string): string {
  return join(userUnitDir(), `${unitBaseName(id)}.service`);
}

export function timerPath(id: string): string {
  return join(userUnitDir(), `${unitBaseName(id)}.timer`);
}

const STEP_EVERY = /^\*\/(\d+)$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayName(n: string): string | undefined {
  const v = Number(n);
  if (!Number.isInteger(v)) return undefined;
  return DAY_NAMES[v % 7]; // cron allows 0 and 7 for Sunday
}

/** Translate a cron day-of-week field to a systemd day prefix (empty when wild/unparseable). */
function dowToSystemd(dow: string): string {
  if (dow === "*") return "";
  if (/^\d+$/.test(dow)) return dayName(dow) ?? "";
  const range = /^(\d+)-(\d+)$/.exec(dow);
  if (range) {
    const a = dayName(range[1]);
    const b = dayName(range[2]);
    return a && b ? `${a}..${b}` : "";
  }
  if (dow.includes(",")) {
    const names = dow.split(",").map((d) => dayName(d.trim()));
    if (names.every(Boolean)) return names.join(",");
  }
  return "";
}

/**
 * Translate a 5-field cron to a systemd OnCalendar expression. Covers the
 * common patterns (every-N-min, every-N-hours, daily/weekly at H:M including
 * day-of-week); approximates the rest with a best-effort date-time mapping.
 */
export function cronToSystemdCalendar(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  const minStep = STEP_EVERY.exec(min);
  if (minStep && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `*:0/${minStep[1]}`; // every N minutes
  }
  const hourStep = STEP_EVERY.exec(hour);
  if (min === "0" && hourStep && dom === "*" && mon === "*" && dow === "*") {
    return `0/${hourStep[1]}:00`; // every N hours
  }
  const pad = (s: string) => (/^\d+$/.test(s) ? s.padStart(2, "0") : "*");
  const time = `${pad(hour)}:${pad(min)}:00`;
  const dayPrefix = dowToSystemd(dow);
  const prefix = dayPrefix ? `${dayPrefix} ` : "";
  if (dom === "*" && mon === "*") {
    return `${prefix}*-*-* ${time}`;
  }
  // best effort with date components
  return `${prefix}*-${pad(mon)}-${pad(dom)} ${time}`;
}

/** Double-quote a value for a systemd unit (handles spaces; escapes backslash and quote). */
function sdq(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

export function generateService(job: ScheduleJob, stateRoot: string): string {
  // Run from stateRoot with --root so state resolves independent of agent cwd.
  // Node + CLI script are invoked explicitly (see invocation.ts): systemd's
  // minimal PATH cannot resolve the `env node` shebang of the omp wrapper.
  const execStart = scheduleRunArgv(job.id, stateRoot).map(sdq).join(" ");
  return `[Unit]
Description=omp scheduled job ${job.id}

[Service]
Type=oneshot
ExecStart=${execStart}
WorkingDirectory=${sdq(stateRoot)}
`;
}

export function generateTimer(job: ScheduleJob): string {
  return `[Unit]
Description=Timer for omp scheduled job ${job.id}

[Timer]
OnCalendar=${cronToSystemdCalendar(job.cron)}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function installSystemd(job: ScheduleJob, stateRoot: string): void {
  mkdirSync(userUnitDir(), { recursive: true });
  writeFileSync(servicePath(job.id), generateService(job, stateRoot), "utf8");
  writeFileSync(timerPath(job.id), generateTimer(job), "utf8");
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  execFileSync("systemctl", ["--user", "enable", "--now", `${unitBaseName(job.id)}.timer`], { stdio: "ignore" });
}

export function uninstallSystemd(id: string): void {
  try {
    execFileSync("systemctl", ["--user", "disable", "--now", `${unitBaseName(id)}.timer`], { stdio: "ignore" });
  } catch {
    // already disabled
  }
  for (const p of [servicePath(id), timerPath(id)]) {
    if (existsSync(p)) unlinkSync(p);
  }
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  } catch {
    // best effort
  }
}

export function statusSystemd(id: string): boolean {
  try {
    const out = execFileSync("systemctl", ["--user", "is-active", `${unitBaseName(id)}.timer`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "active";
  } catch {
    return existsSync(timerPath(id));
  }
}
