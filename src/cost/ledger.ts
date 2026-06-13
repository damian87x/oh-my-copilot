import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

export interface CostRecord {
  ts?: string;
  sessionId: string;
  event: string;
  toolName?: string;
  model?: string;
  inTokens?: number;
  outTokens?: number;
  rawOutTokens?: number;
  savedTokens?: number;
  rawPath?: string;
  estUSD?: number;
  note?: string;
}

export interface ReadCostOptions {
  sessionId?: string;
  today?: boolean;
}

function costDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "state", "cost");
}

function safeSessionId(sessionId: string): string {
  return (
    String(sessionId || "unknown")
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

export function costLedgerPath(cwd: string, sessionId: string): string {
  return join(costDir(cwd), `${safeSessionId(sessionId)}.jsonl`);
}

function normalizeRecord(record: CostRecord): Required<Pick<CostRecord, "ts" | "sessionId" | "event" | "inTokens" | "outTokens">> & CostRecord {
  return {
    ts: record.ts ?? new Date().toISOString(),
    sessionId: record.sessionId || "unknown",
    event: record.event,
    toolName: record.toolName,
    model: record.model,
    inTokens: Number.isFinite(record.inTokens) ? Math.max(0, Number(record.inTokens)) : 0,
    outTokens: Number.isFinite(record.outTokens) ? Math.max(0, Number(record.outTokens)) : 0,
    rawOutTokens: Number.isFinite(record.rawOutTokens) ? Math.max(0, Number(record.rawOutTokens)) : undefined,
    savedTokens: Number.isFinite(record.savedTokens) ? Math.max(0, Number(record.savedTokens)) : undefined,
    rawPath: typeof record.rawPath === "string" ? record.rawPath : undefined,
    estUSD: Number.isFinite(record.estUSD) ? Number(record.estUSD) : undefined,
    note: record.note,
  };
}

export function appendCostRecord(cwd: string, record: CostRecord): string {
  const normalized = normalizeRecord(record);
  const file = costLedgerPath(cwd, normalized.sessionId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(normalized)}\n`, "utf8");
  return file;
}

function readFileRecords(file: string): CostRecord[] {
  if (!existsSync(file)) return [];
  const records: CostRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
        records.push(normalizeRecord(parsed));
      }
    } catch {
      // Ignore corrupt ledger rows; hooks are best-effort and append-only.
    }
  }
  return records;
}

export function readCostRecords(cwd: string, options: ReadCostOptions = {}): CostRecord[] {
  const dir = costDir(cwd);
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const files = options.sessionId
    ? [costLedgerPath(cwd, options.sessionId)]
    : existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith(".jsonl"))
          .sort()
          .map((file) => join(dir, file))
      : [];
  const records = files.flatMap(readFileRecords);
  return options.today ? records.filter((record) => String(record.ts ?? "").startsWith(todayPrefix)) : records;
}
