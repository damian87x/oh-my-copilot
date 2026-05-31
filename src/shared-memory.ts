import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Per-project shared memory with optional TTL at .omp/shared-memory/<key>.json.
// Exposed via the `omp shared-memory` CLI subcommands (NOT MCP).

interface SharedMemoryEntry {
  value: unknown;
  writtenAt: string;
  expiresAt?: string;
}

function smDir(cwd: string): string {
  return join(resolve(cwd), ".omp", "shared-memory");
}

function smPath(cwd: string, key: string): string {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key: ${key}`);
  return join(smDir(cwd), `${key}.json`);
}

export function sharedWrite(cwd: string, key: string, value: unknown, ttlSeconds?: number): string | undefined {
  const entry: SharedMemoryEntry = {
    value,
    writtenAt: new Date().toISOString(),
    expiresAt: ttlSeconds != null ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : undefined,
  };
  const path = smPath(cwd, key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8");
  renameSync(tmp, path);
  return entry.expiresAt;
}

export function sharedRead(cwd: string, key: string): { value: unknown; expired?: boolean } {
  const path = smPath(cwd, key);
  if (!existsSync(path)) return { value: null };
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as SharedMemoryEntry;
    if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
      unlinkSync(path);
      return { value: null, expired: true };
    }
    return { value: entry.value };
  } catch {
    return { value: null };
  }
}

export function sharedList(cwd: string): string[] {
  const dir = smDir(cwd);
  if (!existsSync(dir)) return [];
  const now = Date.now();
  const keys: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as SharedMemoryEntry;
      if (entry.expiresAt && Date.parse(entry.expiresAt) < now) continue;
      keys.push(file.replace(/\.json$/, ""));
    } catch {
      // skip unparseable
    }
  }
  return keys.sort();
}

export function sharedDelete(cwd: string, key: string): void {
  const path = smPath(cwd, key);
  if (existsSync(path)) unlinkSync(path);
}

export function sharedCleanup(cwd: string): number {
  const dir = smDir(cwd);
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  let deleted = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as SharedMemoryEntry;
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
