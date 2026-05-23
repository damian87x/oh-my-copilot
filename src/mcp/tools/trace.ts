import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, type ToolDefinition } from "../types.js";

interface TraceEntry {
  ts: string;
  sessionId?: string;
  event?: string;
  payload?: unknown;
}

function traceDir(cwd: string): string {
  return join(resolve(cwd), ".omc", "state", "trace");
}

function tracePath(cwd: string, sessionId: string): string {
  if (!/^[\w.-]+$/.test(sessionId)) throw new Error(`invalid sessionId: ${sessionId}`);
  return join(traceDir(cwd), `${sessionId}.jsonl`);
}

export function appendTraceEntry(cwd: string, sessionId: string, entry: Omit<TraceEntry, "ts" | "sessionId">): void {
  const path = tracePath(cwd, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), sessionId, ...entry })}\n`, "utf8");
}

function readEntries(path: string): TraceEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as TraceEntry;
      } catch {
        return undefined;
      }
    })
    .filter((e): e is TraceEntry => Boolean(e));
}

function pickSessionId(cwd: string, sessionId?: string): string | undefined {
  if (sessionId) return sessionId;
  const dir = traceDir(cwd);
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return undefined;
  // pick most recently modified
  return files
    .map((f) => ({ name: f.replace(/\.jsonl$/, ""), path: join(dir, f) }))
    .sort((a, b) => {
      try {
        const ai = Number(require("node:fs").statSync(a.path).mtimeMs);
        const bi = Number(require("node:fs").statSync(b.path).mtimeMs);
        return bi - ai;
      } catch {
        return 0;
      }
    })[0]?.name;
}

export const traceTools: ToolDefinition[] = [
  {
    name: "trace_timeline",
    category: "trace",
    description: "Read the last N entries of a session trace (default 50). Defaults to the most recently active session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        limit: { type: "number" },
        cwd: { type: "string" },
      },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const sessionId = pickSessionId(cwd, args.sessionId as string | undefined);
      if (!sessionId) return jsonResult({ entries: [] });
      const limit = typeof args.limit === "number" ? Math.max(1, args.limit) : 50;
      const all = readEntries(tracePath(cwd, sessionId));
      return jsonResult({ sessionId, entries: all.slice(-limit) });
    },
  },
  {
    name: "trace_summary",
    category: "trace",
    description: "Summarise a session trace as event-name counts.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, cwd: { type: "string" } },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const sessionId = pickSessionId(cwd, args.sessionId as string | undefined);
      if (!sessionId) return jsonResult({ counts: {} });
      const entries = readEntries(tracePath(cwd, sessionId));
      const counts: Record<string, number> = {};
      for (const e of entries) {
        const key = e.event ?? "unknown";
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return jsonResult({ sessionId, total: entries.length, counts });
    },
  },
];
