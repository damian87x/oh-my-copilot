import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, type ToolDefinition } from "../types.js";

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

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export const sharedMemoryTools: ToolDefinition[] = [
  {
    name: "shared_memory_write",
    category: "shared_memory",
    description: "Write a shared-memory entry. Optional TTL in seconds.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {} as never,
        ttlSeconds: { type: "number" },
        cwd: { type: "string" },
      },
      required: ["key", "value"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const ttl = typeof args.ttlSeconds === "number" ? args.ttlSeconds : undefined;
      const entry: SharedMemoryEntry = {
        value: args.value,
        writtenAt: new Date().toISOString(),
        expiresAt: ttl != null ? new Date(Date.now() + ttl * 1000).toISOString() : undefined,
      };
      atomicWrite(smPath(cwd, args.key as string), entry);
      return jsonResult({ ok: true, expiresAt: entry.expiresAt });
    },
  },
  {
    name: "shared_memory_read",
    category: "shared_memory",
    description: "Read a shared-memory entry. Returns null if missing or expired.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, cwd: { type: "string" } },
      required: ["key"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const path = smPath(cwd, args.key as string);
      if (!existsSync(path)) return jsonResult({ value: null });
      try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as SharedMemoryEntry;
        if (entry.expiresAt && Date.parse(entry.expiresAt) < Date.now()) {
          unlinkSync(path);
          return jsonResult({ value: null, expired: true });
        }
        return jsonResult({ value: entry.value, writtenAt: entry.writtenAt, expiresAt: entry.expiresAt });
      } catch {
        return jsonResult({ value: null });
      }
    },
  },
  {
    name: "shared_memory_list",
    category: "shared_memory",
    description: "List shared-memory keys (excluding expired entries).",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const dir = smDir(cwd);
      if (!existsSync(dir)) return jsonResult({ keys: [] });
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
      return jsonResult({ keys: keys.sort() });
    },
  },
  {
    name: "shared_memory_delete",
    category: "shared_memory",
    description: "Delete a shared-memory entry.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, cwd: { type: "string" } },
      required: ["key"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const path = smPath(cwd, args.key as string);
      if (existsSync(path)) unlinkSync(path);
      return jsonResult({ ok: true });
    },
  },
  {
    name: "shared_memory_cleanup",
    category: "shared_memory",
    description: "Delete all expired shared-memory entries.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const dir = smDir(cwd);
      if (!existsSync(dir)) return jsonResult({ deleted: 0 });
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
      return jsonResult({ deleted });
    },
  },
];
