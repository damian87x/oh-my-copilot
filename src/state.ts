import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// Per-project key-value store with optional TTL at .omp/state/kv/<key>.json.
// (Merges the former `state` + `shared-memory` — same mechanism; this is the
// one generic KV.) Exposed via the `omp state` CLI subcommands (NOT MCP).

interface Entry {
  value: unknown;
  writtenAt: string;
  expiresAt?: string;
}

function kvDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "state", "kv");
}

function kvPath(cwd: string, key: string): string {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key: ${key}`);
  return join(kvDir(cwd), `${key}.json`);
}

/** Write a value under a key, with an optional TTL in seconds. Returns expiresAt. */
export function stateWrite(cwd: string, key: string, value: unknown, ttlSeconds?: number): string | undefined {
  const entry: Entry = {
    value,
    writtenAt: new Date().toISOString(),
    expiresAt: ttlSeconds != null ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : undefined,
  };
  const path = kvPath(cwd, key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
  renameSync(tmp, path);
  return entry.expiresAt;
}

/** Read a value. Returns { value: null } when missing; auto-deletes if expired. */
export function stateRead(cwd: string, key: string): { value: unknown; expired?: boolean } {
  const path = kvPath(cwd, key);
  if (!existsSync(path)) return { value: null };
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
    if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
      unlinkSync(path);
      return { value: null, expired: true };
    }
    return { value: entry.value };
  } catch {
    return { value: null };
  }
}

export function stateDelete(cwd: string, key: string): void {
  const path = kvPath(cwd, key);
  if (existsSync(path)) unlinkSync(path);
}

/** List live (non-expired) keys. */
export function stateList(cwd: string): string[] {
  const dir = kvDir(cwd);
  if (!existsSync(dir)) return [];
  const now = Date.now();
  const keys: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, f), "utf8")) as Entry;
      if (entry.expiresAt && Date.parse(entry.expiresAt) < now) continue;
      keys.push(f.replace(/\.json$/, ""));
    } catch {
      // skip unparseable
    }
  }
  return keys.sort();
}

/** Delete all expired entries; returns the count removed. */
export function stateCleanup(cwd: string): number {
  const dir = kvDir(cwd);
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
      if (entry.expiresAt && Date.parse(entry.expiresAt) < now) {
        unlinkSync(path);
        deleted++;
      }
    } catch {
      // skip
    }
  }
  return deleted;
}

export function stateStatus(cwd: string, key: string): { exists: boolean; mtime?: string; bytes?: number } {
  const path = kvPath(cwd, key);
  if (!existsSync(path)) return { exists: false };
  const s = statSync(path);
  return { exists: true, mtime: s.mtime.toISOString(), bytes: s.size };
}
