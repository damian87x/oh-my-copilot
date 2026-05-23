import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

function stateDir(cwd: string): string {
  return join(resolve(cwd), ".omc", "state", "kv");
}

function statePath(cwd: string, key: string): string {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid key: ${key}`);
  return join(stateDir(cwd), `${key}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export const stateTools: ToolDefinition[] = [
  {
    name: "state_read",
    category: "state",
    description: "Read a key-value entry from .omc/state/kv/<key>.json.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name (letters, digits, ., -, _)." },
        cwd: { type: "string", description: "Optional working directory." },
      },
      required: ["key"],
    },
    handler: (args) => {
      const path = statePath((args.cwd as string) ?? process.cwd(), args.key as string);
      if (!existsSync(path)) return jsonResult({ value: null });
      return jsonResult({ value: JSON.parse(readFileSync(path, "utf8")) });
    },
  },
  {
    name: "state_write",
    category: "state",
    description: "Write a key-value entry to .omc/state/kv/<key>.json (atomic).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {} as never,
        cwd: { type: "string" },
      },
      required: ["key", "value"],
    },
    handler: (args) => {
      const path = statePath((args.cwd as string) ?? process.cwd(), args.key as string);
      atomicWriteJson(path, args.value);
      return jsonResult({ ok: true, path });
    },
  },
  {
    name: "state_clear",
    category: "state",
    description: "Delete a key-value entry.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, cwd: { type: "string" } },
      required: ["key"],
    },
    handler: (args) => {
      const path = statePath((args.cwd as string) ?? process.cwd(), args.key as string);
      if (existsSync(path)) unlinkSync(path);
      return jsonResult({ ok: true });
    },
  },
  {
    name: "state_list_active",
    category: "state",
    description: "List all active state keys under .omc/state/kv/.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => {
      const dir = stateDir((args.cwd as string) ?? process.cwd());
      if (!existsSync(dir)) return jsonResult({ keys: [] });
      const keys = readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      return jsonResult({ keys });
    },
  },
  {
    name: "state_get_status",
    category: "state",
    description: "Get existence + mtime for a single state key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, cwd: { type: "string" } },
      required: ["key"],
    },
    handler: (args) => {
      const path = statePath((args.cwd as string) ?? process.cwd(), args.key as string);
      if (!existsSync(path)) return jsonResult({ exists: false });
      const stats = statSync(path);
      return jsonResult({ exists: true, mtime: stats.mtime.toISOString(), bytes: stats.size });
    },
  },
];
