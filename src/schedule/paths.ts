import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SchedulePaths {
  cwd: string;
  scheduleRoot: string;
  jobsDir: string;
  logsDir: string;
  resultsDir: string;
}

export function resolveSchedulePaths(cwd: string): SchedulePaths {
  const root = resolve(cwd);
  const scheduleRoot = join(root, ".omp", "state", "schedule");
  return {
    cwd: root,
    scheduleRoot,
    jobsDir: join(scheduleRoot, "jobs"),
    logsDir: join(scheduleRoot, "logs"),
    resultsDir: join(scheduleRoot, "results"),
  };
}

export function jobFilePath(jobsDir: string, id: string): string {
  return join(jobsDir, `${id}.json`);
}

export function jobLockPath(jobsDir: string, id: string): string {
  return join(jobsDir, `${id}.lock`);
}

export function runLogDir(logsDir: string, id: string): string {
  return join(logsDir, id);
}

export function resultsFilePath(resultsDir: string, id: string): string {
  return join(resultsDir, `${id}.jsonl`);
}

/** Byte-offset cursor for "seen" results (mirrors team outbox `.offset`). */
export function resultsCursorPath(resultsDir: string, id: string): string {
  return join(resultsDir, `${id}.offset`);
}

export function ensureScheduleDirs(paths: SchedulePaths): void {
  for (const dir of [paths.scheduleRoot, paths.jobsDir, paths.logsDir, paths.resultsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
