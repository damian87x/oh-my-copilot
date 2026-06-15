import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensureDir, readJSON } from "./utils/fs.js";
import { statePath } from "./utils/paths.js";

// Per-project key-value store with optional TTL at .omp/state/kv/<key>.json.
// (Merges the former `state` + `shared-memory` — same mechanism; this is the
// one generic KV.) Exposed via the `omp state` CLI subcommands (NOT MCP).

interface Entry {
  value: unknown;
  writtenAt: string;
  expiresAt?: string;
}

function kvDir(cwd: string): string {
  return statePath(cwd, "kv");
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
  ensureDir(path);
  atomicWrite(path, JSON.stringify(entry, null, 2));
  return entry.expiresAt;
}

/** Read a value. Returns { value: null } when missing; auto-deletes if expired. */
export function stateRead(cwd: string, key: string): { value: unknown; expired?: boolean } {
  const path = kvPath(cwd, key);
  const entry = readJSON<Entry | null>(path, null);
  if (!entry) return { value: null };
  if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
    unlinkSync(path);
    return { value: null, expired: true };
  }
  return { value: entry.value };
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
    const entry = readJSON<Entry | null>(join(dir, f), null);
    if (!entry) continue;
    if (entry.expiresAt && Date.parse(entry.expiresAt) < now) continue;
    keys.push(f.replace(/\.json$/, ""));
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
    const entry = readJSON<Entry | null>(path, null);
    if (!entry) continue;
    if (entry.expiresAt && Date.parse(entry.expiresAt) < now) {
      unlinkSync(path);
      deleted++;
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
