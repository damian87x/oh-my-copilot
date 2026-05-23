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

export function tryClaimTask(opts: ClaimOptions): ClaimResult {
  const path = taskFilePath(opts.tasksDir, opts.taskId);
  const task = readTask(path);
  if (!task) return { ok: false, reason: `task ${opts.taskId} not found` };
  if (task.status !== "pending") {
    return { ok: false, reason: `task ${opts.taskId} status=${task.status}` };
  }

  const lockPath = taskLockPath(opts.tasksDir, opts.taskId);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return { ok: false, reason: "task already locked by another worker" };
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ owner: opts.worker, claimedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
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
  return { ok: true, task: updated, claimToken };
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
