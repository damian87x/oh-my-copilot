import { readCostRecords, type CostRecord, type ReadCostOptions } from "./ledger.js";
import { ompRoot } from "../omp-root.js";

export interface CostBucket {
  inTokens: number;
  outTokens: number;
  totalTokens: number;
  records: number;
}

export interface CostSink extends CostBucket {
  label: string;
}

export interface CostSummary {
  root: string;
  records: number;
  sessions: string[];
  totals: CostBucket;
  byEvent: Record<string, CostBucket>;
  byTool: Record<string, CostBucket>;
  byModel: Record<string, CostBucket>;
  topSinks: CostSink[];
}

function emptyBucket(): CostBucket {
  return { inTokens: 0, outTokens: 0, totalTokens: 0, records: 0 };
}

function addTo(bucket: CostBucket, record: CostRecord): void {
  const inTokens = record.inTokens ?? 0;
  const outTokens = record.outTokens ?? 0;
  bucket.inTokens += inTokens;
  bucket.outTokens += outTokens;
  bucket.totalTokens += inTokens + outTokens;
  bucket.records += 1;
}

function addGroup(groups: Record<string, CostBucket>, key: string | undefined, record: CostRecord): void {
  if (!key) return;
  groups[key] ??= emptyBucket();
  addTo(groups[key], record);
}

export function summarizeCost(cwd: string, options: ReadCostOptions = {}): CostSummary {
  const root = ompRoot(cwd);
  const records = readCostRecords(root, options);
  const totals = emptyBucket();
  const byEvent: Record<string, CostBucket> = {};
  const byTool: Record<string, CostBucket> = {};
  const byModel: Record<string, CostBucket> = {};
  const sessions = new Set<string>();

  for (const record of records) {
    sessions.add(record.sessionId);
    addTo(totals, record);
    addGroup(byEvent, record.event, record);
    addGroup(byTool, record.toolName, record);
    addGroup(byModel, record.model, record);
  }

  const toolSinks = Object.entries(byTool).map(([key, bucket]) => ({ label: `tool:${key}`, ...bucket }));
  const eventSinks = Object.entries(byEvent).map(([key, bucket]) => ({ label: `event:${key}`, ...bucket }));
  const topSinks = [...toolSinks, ...eventSinks]
    .sort(
      (a, b) =>
        b.totalTokens - a.totalTokens ||
        Number(b.label.startsWith("tool:")) - Number(a.label.startsWith("tool:")) ||
        a.label.localeCompare(b.label),
    )
    .slice(0, 10);

  return {
    root,
    records: records.length,
    sessions: [...sessions].sort(),
    totals,
    byEvent,
    byTool,
    byModel,
    topSinks,
  };
}

export function formatCostSummary(summary: CostSummary): string {
  const lines = [
    `Cost ledger: ${summary.root}`,
    `records: ${summary.records}`,
    `sessions: ${summary.sessions.length ? summary.sessions.join(", ") : "(none)"}`,
    `tokens: ${summary.totals.totalTokens} (in ${summary.totals.inTokens}, out ${summary.totals.outTokens})`,
  ];
  if (summary.topSinks.length > 0) {
    lines.push("top sinks:");
    for (const sink of summary.topSinks.slice(0, 5)) {
      lines.push(`  ${sink.label}: ${sink.totalTokens} tokens (${sink.records} record${sink.records === 1 ? "" : "s"})`);
    }
  }
  return lines.join("\n");
}
