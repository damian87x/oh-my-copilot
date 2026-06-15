import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
