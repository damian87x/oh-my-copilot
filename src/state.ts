import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Generic per-project key-value state at .omp/state/kv/<key>.json. Exposed via
// the `omp state` CLI subcommands (NOT MCP).

function stateDir(cwd: string): string {
  return join(resolve(cwd), ".omp", "state", "kv");
}

function statePath(cwd: string, key: string): string {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key: ${key}`);
  return join(stateDir(cwd), `${key}.json`);
}

export function stateRead(cwd: string, key: string): unknown {
  const p = statePath(cwd, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function stateWrite(cwd: string, key: string, value: unknown): string {
  const p = statePath(cwd, key);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, p);
  return p;
}

export function stateClear(cwd: string, key: string): void {
  const p = statePath(cwd, key);
  if (existsSync(p)) unlinkSync(p);
}

export function stateList(cwd: string): string[] {
  const dir = stateDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function stateStatus(cwd: string, key: string): { exists: boolean; mtime?: string; bytes?: number } {
  const p = statePath(cwd, key);
  if (!existsSync(p)) return { exists: false };
  const s = statSync(p);
  return { exists: true, mtime: s.mtime.toISOString(), bytes: s.size };
}
