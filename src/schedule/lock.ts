import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface LockHandle {
  acquired: boolean;
  release: () => void;
}

interface LockData {
  pid: number;
  acquiredAt: string;
  token: string;
}

function readLock(lockPath: string): LockData | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockData;
  } catch {
    return undefined;
  }
}

/** Acquire an exclusive lock via `openSync(..., 'wx')` (mirrors task-store). */
export function acquireLock(lockPath: string): LockHandle {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    return { acquired: false, release: () => {} };
  }
  const token = randomUUID();
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token } satisfies LockData));
  } finally {
    closeSync(fd);
  }
  return {
    acquired: true,
    // Only delete the lock if it is still OURS — a stale-steal may have replaced
    // it with a newer holder's lock, which we must not unlink.
    release: () => {
      if (readLock(lockPath)?.token === token) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore: already gone
        }
      }
    },
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process (dead). EPERM => exists but not ours (alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is stale if its owner PID is dead or it is older than 2× maxAgeMs. */
export function isLockStale(lockPath: string, maxAgeMs: number): boolean {
  if (!existsSync(lockPath)) return false;
  let data: LockData;
  try {
    data = JSON.parse(readFileSync(lockPath, "utf8")) as LockData;
  } catch {
    return true; // unparseable lock is stale
  }
  if (!pidAlive(data.pid)) return true;
  const age = Date.now() - Date.parse(data.acquiredAt);
  return Number.isFinite(age) && age > 2 * maxAgeMs;
}

export function forceReleaseStaleLock(lockPath: string, maxAgeMs: number): void {
  if (isLockStale(lockPath, maxAgeMs)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}
