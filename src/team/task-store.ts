import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Task, TaskStatus } from "./types.js";

export function taskFilePath(tasksDir: string, taskId: string): string {
  return join(tasksDir, `${taskId}.json`);
}

export function taskLockPath(tasksDir: string, taskId: string): string {
  return join(tasksDir, `${taskId}.lock`);
}

export function writeTask(taskPath: string, task: Task): void {
  mkdirSync(dirname(taskPath), { recursive: true });
  const tmp = `${taskPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(task, null, 2), "utf8");
  renameSync(tmp, taskPath);
}

export function readTask(taskPath: string): Task | undefined {
  if (!existsSync(taskPath)) return undefined;
  try {
    return JSON.parse(readFileSync(taskPath, "utf8")) as Task;
  } catch {
    return undefined;
  }
}

export function listTasks(tasksDir: string): Task[] {
  if (!existsSync(tasksDir)) return [];
  const out: Task[] = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const t = readTask(join(tasksDir, entry.name));
    if (t) out.push(t);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ClaimOptions {
  tasksDir: string;
  taskId: string;
  worker: string;
}

export interface ClaimResult {
  ok: boolean;
  task?: Task;
  claimToken?: string;
  reason?: string;
}

function openLockExclusive(lockPath: string, worker: string): number | undefined {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ owner: worker, pid: process.pid, claimedAt: new Date().toISOString() }),
      );
    } finally {
      closeSync(fd);
    }
    return fd;
  } catch {
    return undefined;
  }
}

export function tryClaimTask(opts: ClaimOptions): ClaimResult {
  const path = taskFilePath(opts.tasksDir, opts.taskId);
  const task = readTask(path);
  if (!task) return { ok: false, reason: `task ${opts.taskId} not found` };
  if (task.status !== "pending") {
    return { ok: false, reason: `task ${opts.taskId} status=${task.status}` };
  }

  const lockPath = taskLockPath(opts.tasksDir, opts.taskId);
  let fd = openLockExclusive(lockPath, opts.worker);

  if (fd === undefined) {
    // Lock exists. Re-read task status: if still pending, the lock is orphan
    // (previous worker crashed between lock-acquire and task-write). Force-claim.
    const recheck = readTask(path);
    if (recheck?.status !== "pending") {
      return { ok: false, reason: `task ${opts.taskId} status=${recheck?.status ?? "missing"}` };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore: race with another claimer; the second openSync will arbitrate
    }
    fd = openLockExclusive(lockPath, opts.worker);
    if (fd === undefined) return { ok: false, reason: "concurrent claim race" };
  }

  const claimToken = `${opts.worker}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const updated: Task = {
    ...task,
    status: "in_progress",
    owner: opts.worker,
    startedAt: new Date().toISOString(),
    claimToken,
  };
  writeTask(path, updated);

  // Optimistic CAS verification: re-read the task and confirm OUR claimToken
  // landed. If a concurrent orphan-stealer raced us, their writeTask may have
  // overwritten ours (writeTask is rename-atomic, so the last writer wins).
  // Both workers' lock-acquire could succeed if B unlinks A's freshly-created
  // lock between A's openSync and A's writeTask. The verify is the
  // ground-truth tiebreaker — only the worker whose claimToken is currently
  // persisted owns the task.
  const verified = readTask(path);
  if (verified?.claimToken !== claimToken) {
    return { ok: false, reason: "concurrent claim overwrote ours; retry" };
  }

  return { ok: true, task: updated, claimToken };
}

export interface ClearLocksResult {
  removed: number;
  failures: Array<{ path: string; error: string }>;
}

export function clearAllLocks(tasksDir: string): number {
  return clearAllLocksDetailed(tasksDir).removed;
}

export function clearAllLocksDetailed(tasksDir: string): ClearLocksResult {
  if (!existsSync(tasksDir)) return { removed: 0, failures: [] };
  const failures: ClearLocksResult["failures"] = [];
  let removed = 0;
  for (const entry of readdirSync(tasksDir)) {
    if (!entry.endsWith(".lock")) continue;
    const target = join(tasksDir, entry);
    try {
      unlinkSync(target);
      removed++;
    } catch (err) {
      failures.push({ path: target, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, failures };
}

export interface TransitionOptions {
  tasksDir: string;
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  claimToken: string;
  result?: string;
}

export interface TransitionResult {
  ok: boolean;
  task?: Task;
  reason?: string;
}

const TERMINAL: TaskStatus[] = ["completed", "failed"];

export function transitionTask(opts: TransitionOptions): TransitionResult {
  const path = taskFilePath(opts.tasksDir, opts.taskId);
  const task = readTask(path);
  if (!task) return { ok: false, reason: `task ${opts.taskId} not found` };
  if (task.status !== opts.from) {
    return { ok: false, reason: `task ${opts.taskId} status=${task.status}, expected ${opts.from}` };
  }
  if (task.claimToken && task.claimToken !== opts.claimToken) {
    return { ok: false, reason: "claim token mismatch" };
  }
  const updated: Task = {
    ...task,
    status: opts.to,
    result: opts.result ?? task.result,
    finishedAt: TERMINAL.includes(opts.to) ? new Date().toISOString() : task.finishedAt,
  };
  writeTask(path, updated);
  if (TERMINAL.includes(opts.to)) {
    try {
      unlinkSync(taskLockPath(opts.tasksDir, opts.taskId));
    } catch {
      // ignore: lock may already be gone
    }
  }
  return { ok: true, task: updated };
}
