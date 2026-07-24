import { execSync } from "node:child_process";
import { join } from "node:path";
import { scheduleRunArgv } from "./invocation.js";
import type { ScheduleJob } from "../types.js";

export const BLOCK_BEGIN = "# BEGIN omp-schedule";
export const BLOCK_END = "# END omp-schedule";
const ID_PREFIX = "# omp:";

/** Single-quote a value for safe shell interpolation. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The crontab command line for a job (without the id marker). */
export function crontabEntryLine(job: ScheduleJob, logsDir: string, stateRoot: string): string {
  const logFile = join(logsDir, job.id, `${job.id}.cron.log`);
  // `omp schedule run` resolves state from --root (independent of the agent cwd).
  // Node + CLI script are invoked explicitly (see invocation.ts): cron's minimal
  // PATH cannot resolve the `env node` shebang of the omp wrapper.
  const cmd = scheduleRunArgv(job.id, stateRoot).map(shq).join(" ");
  return `${job.cron} ${cmd} >> ${shq(logFile)} 2>&1`;
}

/** Parse the managed block of an existing crontab into an ordered id→line map. */
export function parseManagedBlock(existing: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = existing.split("\n");
  let inBlock = false;
  let currentId: string | undefined;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    if (line.startsWith(ID_PREFIX)) {
      currentId = line.slice(ID_PREFIX.length).trim();
      continue;
    }
    if (currentId && line.trim()) {
      out.set(currentId, line);
      currentId = undefined;
    }
  }
  return out;
}

/** Strip the managed block, returning everything outside it (trimmed). */
function stripManagedBlock(existing: string): string {
  const lines = existing.split("\n");
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Render a fresh crontab from outside-block content + the managed entries. */
function render(outside: string, entries: Map<string, string>): string {
  if (entries.size === 0) {
    return outside ? `${outside}\n` : "";
  }
  const block: string[] = [BLOCK_BEGIN];
  for (const [id, line] of entries) {
    block.push(`${ID_PREFIX}${id}`, line);
  }
  block.push(BLOCK_END);
  return `${outside ? `${outside}\n\n` : ""}${block.join("\n")}\n`;
}

/** Pure: add or replace the entry for `id` in the managed block. */
export function applyCrontabBlock(existing: string, id: string, entryLine: string): string {
  const entries = parseManagedBlock(existing);
  entries.set(id, entryLine);
  return render(stripManagedBlock(existing), entries);
}

/** Pure: remove the entry for `id`; drops the block markers when it empties. */
export function removeCrontabEntry(existing: string, id: string): string {
  const entries = parseManagedBlock(existing);
  entries.delete(id);
  return render(stripManagedBlock(existing), entries);
}

export function hasCrontabEntry(existing: string, id: string): boolean {
  return parseManagedBlock(existing).has(id);
}

export function readCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf8" });
  } catch {
    return ""; // no crontab yet
  }
}

export function writeCrontab(content: string): void {
  execSync("crontab -", { input: content });
}

export function installCrontab(job: ScheduleJob, logsDir: string, stateRoot: string): string {
  const next = applyCrontabBlock(readCrontab(), job.id, crontabEntryLine(job, logsDir, stateRoot));
  writeCrontab(next);
  return "crontab";
}

export function uninstallCrontab(id: string): void {
  writeCrontab(removeCrontabEntry(readCrontab(), id));
}

export function statusCrontab(id: string): boolean {
  return hasCrontabEntry(readCrontab(), id);
}
