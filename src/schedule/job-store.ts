import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ScheduleJob, ScheduleRunResult } from "./types.js";

/** Atomic write (tmp + rename), mirroring task-store.writeTask. */
export function writeJob(jobPath: string, job: ScheduleJob): void {
  mkdirSync(dirname(jobPath), { recursive: true });
  const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(job, null, 2), "utf8");
  renameSync(tmp, jobPath);
}

export function readJob(jobPath: string): ScheduleJob | undefined {
  if (!existsSync(jobPath)) return undefined;
  try {
    return JSON.parse(readFileSync(jobPath, "utf8")) as ScheduleJob;
  } catch {
    return undefined;
  }
}

export function listJobs(jobsDir: string): ScheduleJob[] {
  if (!existsSync(jobsDir)) return [];
  const out: ScheduleJob[] = [];
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const job = readJob(join(jobsDir, entry.name));
    if (job) out.push(job);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function deleteJob(jobPath: string): void {
  if (existsSync(jobPath)) unlinkSync(jobPath);
}

/** Append a result line. Append-only — never read-modify-write (race-free under concurrent runs). */
export function appendRunResult(resultsPath: string, result: ScheduleRunResult): void {
  mkdirSync(dirname(resultsPath), { recursive: true });
  appendFileSync(resultsPath, `${JSON.stringify(result)}\n`, "utf8");
}

function readCursorBytes(cursorPath: string): number {
  if (!existsSync(cursorPath)) return 0;
  try {
    const data = JSON.parse(readFileSync(cursorPath, "utf8")) as { bytesRead?: number };
    return Number(data.bytesRead) || 0;
  } catch {
    return 0;
  }
}

/** Atomic write of the byte-offset cursor (tmp + rename). */
export function advanceCursor(cursorPath: string, bytes: number): void {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmp = `${cursorPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ bytesRead: bytes }), "utf8");
  renameSync(tmp, cursorPath);
}

export interface ResultsScan {
  results: ScheduleRunResult[];
  newCursor: number;
  cursor: number;
}

/**
 * Read result lines from the stored byte offset to EOF, parsing only complete
 * lines. Mirrors outbox.scanFromCursor. `maxBytes` bounds the read so a hook
 * with a tight time budget never scans an unbounded file.
 */
export function readResultsFrom(
  resultsPath: string,
  cursorPath: string,
  maxBytes = 16_384,
): ResultsScan {
  let cursor = readCursorBytes(cursorPath);
  if (!existsSync(resultsPath)) return { results: [], newCursor: cursor, cursor };
  const stats = statSync(resultsPath);
  if (cursor > stats.size) cursor = 0; // file truncated/rotated → re-read from start
  if (cursor >= stats.size) return { results: [], newCursor: cursor, cursor };

  const remaining = Math.min(stats.size - cursor, maxBytes);
  const fd = openSync(resultsPath, "r");
  const buf = Buffer.alloc(remaining);
  try {
    readSync(fd, buf, 0, remaining, cursor);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { results: [], newCursor: cursor, cursor };

  const consumed = text.slice(0, lastNewline + 1);
  const newCursor = cursor + Buffer.byteLength(consumed, "utf8");
  const results: ScheduleRunResult[] = [];
  for (const line of consumed.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as ScheduleRunResult);
    } catch {
      // ignore unparseable line; cursor still advances past it
    }
  }
  return { results, newCursor, cursor };
}
