import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// Per-session event traces at .omp/state/trace/<sessionId>.jsonl. Exposed via
// the `omp trace` CLI subcommands (NOT MCP).

interface TraceEntry {
  ts: string;
  sessionId?: string;
  event?: string;
  payload?: unknown;
}

function traceDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "state", "trace");
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
  // pick the most recently modified session
  return files
    .map((f) => ({ name: f.replace(/\.jsonl$/, ""), path: join(dir, f) }))
    .sort((a, b) => {
      try {
        return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
      } catch {
        return 0;
      }
    })[0]?.name;
}

/** Last `limit` entries of a session (default 50; most recent session if omitted). */
export function traceTimeline(
  cwd: string,
  sessionId?: string,
  limit = 50,
): { sessionId?: string; entries: TraceEntry[] } {
  const sid = pickSessionId(cwd, sessionId);
  if (!sid) return { entries: [] };
  return { sessionId: sid, entries: readEntries(tracePath(cwd, sid)).slice(-Math.max(1, limit)) };
}

/** Event-name counts for a session. */
export function traceSummary(
  cwd: string,
  sessionId?: string,
): { sessionId?: string; total: number; counts: Record<string, number> } {
  const sid = pickSessionId(cwd, sessionId);
  if (!sid) return { total: 0, counts: {} };
  const entries = readEntries(tracePath(cwd, sid));
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const key = e.event ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { sessionId: sid, total: entries.length, counts };
}
