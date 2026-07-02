import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Atomically write content to a file using a temporary file + rename.
 * Ensures the target file is never left in a partially-written state.
 */
export function atomicWrite(path: string, content: string | Buffer): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Ensure the directory for the given path exists, creating it recursively if needed.
 */
export function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Read and parse JSON from a file, returning the fallback value if the file
 * doesn't exist or cannot be parsed.
 */
export function readJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Read a bounded prefix and mtime from one opened file descriptor. Opening
 * before stat/read avoids path-based check-then-use races when files are
 * concurrently removed or replaced.
 */
export function readFilePrefixWithStat(path: string, maxBytes: number): { text: string; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    const len = Math.max(0, Math.min(stat.size, maxBytes));
    const buffer = Buffer.alloc(len);
    if (len > 0) readSync(fd, buffer, 0, len, 0);
    return { text: buffer.toString("utf8"), mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}
