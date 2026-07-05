import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ompRoot } from "../omp-root.js";
import { statePath } from "../utils/paths.js";

export interface SchedulePaths {
  cwd: string;
  scheduleRoot: string;
  jobsDir: string;
  logsDir: string;
  resultsDir: string;
}

export function resolveSchedulePaths(cwd: string): SchedulePaths {
  const root = ompRoot(cwd);
  const scheduleRoot = statePath(root, "schedule");
  return {
    cwd: root,
    scheduleRoot,
    jobsDir: join(scheduleRoot, "jobs"),
    logsDir: join(scheduleRoot, "logs"),
    resultsDir: join(scheduleRoot, "results"),
  };
}

function nestedDirs(cwd: string, root: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  const stop = resolve(root);
  while (dir !== stop) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function isNonEmptyDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function nestedScheduleJobsWarnings(cwd: string): string[] {
  const root = ompRoot(cwd);
  return nestedDirs(cwd, root)
    .map((dir) => join(dir, ".omp", "state", "schedule", "jobs"))
    .filter(isNonEmptyDir)
    .map(
      (jobsDir) =>
        `[OMP WARNING] Non-empty nested schedule jobs found at ${jobsDir}. ` +
        `omp schedule now manages jobs under ${statePath(root, "schedule", "jobs")}. ` +
        "These nested jobs may still run if an OS scheduler entry pins their old root; review/remove them there and uninstall old scheduler entries if needed.",
    );
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
