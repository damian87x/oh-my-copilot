import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isValidSessionId } from "../memory-review/transcript.js";

export type HistoryWindow = "7d" | "30d" | "90d" | "all";
export type HistoryProjectScope = "current" | "all";
export interface AnalyzeHistoryOptions {
  window: HistoryWindow;
  project: HistoryProjectScope;
  cwd: string;
  sessionStateDir?: string;
  now?: Date;
}
export interface HistoryWarning {
  code: string;
  count: number;
  message: string;
}
export interface HistorySkillRow {
  skill: string;
  invocations: number;
  sessions: number;
  lastInvokedAt: string;
}
export interface UsageTotals {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalNanoAiu?: number;
  premiumRequests?: number;
  durationMs?: number;
}
export type MetricSessions = Partial<Record<keyof UsageTotals, number>>;
export interface UsageBucket {
  sessions: number;
  sessionsWithTelemetry: number;
  totals: UsageTotals;
  metricSessions: MetricSessions;
}
export interface SingleSkillAssociation extends UsageBucket {
  skill: string;
}
export interface HistoryAnalysis {
  schemaVersion: 1;
  generatedAt: string;
  filters: { window: HistoryWindow; project: HistoryProjectScope; cwd: string; since: string | null };
  coverage: { sessionsDiscovered: number; sessionsRead: number; sessionsMatched: number; sessionsWithInvocations: number; filesUnreadable: number; malformedLines: number; invocationsCounted: number; shutdownTelemetrySessions: number };
  skills: HistorySkillRow[];
  sessionUsage: UsageBucket & { attribution: "session-level-only"; singleSkillAssociations: SingleSkillAssociation[]; sharedSkillSessions: UsageBucket };
  warnings: HistoryWarning[];
}

const DAYS: Record<Exclude<HistoryWindow, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };
const WARNING_MESSAGES: Record<string, (count: number) => string> = {
  invalid_session_id: (n) => `${n} session directories had invalid identifiers and were skipped.`,
  malformed_jsonl: (n) => `${n} event lines were malformed and skipped; invocation counts cover readable events only.`,
  missing_session_start: (n) => `${n} sessions lacked a valid session.start timestamp; event-file mtime was used for window filtering.`,
  missing_start_cwd: (n) => `${n} sessions lacked a valid start cwd and were excluded from current-project scope.`,
  session_state_missing: () => "The Copilot session-state directory does not exist; the report is empty.",
  unreadable_events: (n) => `${n} session event files were unreadable and skipped.`,
  malformed_shutdown_telemetry: (n) => `${n} shutdown telemetry values were malformed and skipped.`,
  incomplete_shutdown_telemetry: (n) => `${n} skill sessions had incomplete shutdown telemetry; each total reports its own session coverage.`,
  missing_shutdown_telemetry: (n) => `${n} skill sessions had no usable shutdown telemetry.`,
};

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function addTotals(target: UsageTotals, targetCoverage: MetricSessions, source: UsageTotals): void {
  for (const key of Object.keys(source) as (keyof UsageTotals)[]) {
    target[key] = Number(((target[key] ?? 0) + (source[key] ?? 0)).toPrecision(15));
    targetCoverage[key] = (targetCoverage[key] ?? 0) + 1;
  }
}

function sortSkillRows<T extends HistorySkillRow>(rows: T[]): T[] {
  return rows.sort(
    (left, right) =>
      right.invocations - left.invocations ||
      right.sessions - left.sessions ||
      right.lastInvokedAt.localeCompare(left.lastInvokedAt) ||
      left.skill.localeCompare(right.skill),
  );
}

export function analyzeHistory(options: AnalyzeHistoryOptions): HistoryAnalysis {
  const now = options.now ?? new Date();
  const cwd = resolve(options.cwd);
  const sinceMs = options.window === "all" ? null : now.getTime() - DAYS[options.window] * 86400000;
  const root = options.sessionStateDir ?? join(homedir(), ".copilot", "session-state");
  const warnings = new Map<string, number>();
  const warn = (code: string, n = 1) => warnings.set(code, (warnings.get(code) ?? 0) + n);
  const coverage = {
    sessionsDiscovered: 0,
    sessionsRead: 0,
    sessionsMatched: 0,
    sessionsWithInvocations: 0,
    filesUnreadable: 0,
    malformedLines: 0,
    invocationsCounted: 0,
    shutdownTelemetrySessions: 0,
  };
  const aggregates = new Map<string, { invocations: number; sessions: Set<string>; last: number }>();
  const totals: UsageTotals = {};
  const metricSessions: MetricSessions = {};
  const single = new Map<string, UsageBucket>();
  const shared: UsageBucket = { sessions: 0, sessionsWithTelemetry: 0, totals: {}, metricSessions: {} };
  let skillSessions = 0;
  let telemetrySessions = 0;

  if (!existsSync(root)) warn("session_state_missing");
  else if (!statSync(root).isDirectory()) throw new Error(`session-state path is not a directory: ${root}`);
  else for (const id of readdirSync(root)) {
    let directory: boolean;
    try {
      directory = statSync(join(root, id)).isDirectory();
    } catch {
      continue;
    }
    if (!directory) continue;
    coverage.sessionsDiscovered++;
    if (!isValidSessionId(id)) {
      warn("invalid_session_id");
      continue;
    }
    const path = join(root, id, "events.jsonl");
    let raw: string;
    let mtime: number;
    try {
      raw = readFileSync(path, "utf8");
      const eventFile = statSync(path);
      mtime = eventFile.mtimeMs;
      coverage.sessionsRead++;
    } catch {
      coverage.filesUnreadable++;
      warn("unreadable_events");
      continue;
    }
    let startTime: number | null = null;
    let startCwd: string | null = null;
    const invocations: { skill: string; at: number | null }[] = [];
    let shutdown: UsageTotals | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const event = record(parsed);
        if (!event) continue;
        const data = record(event.data) ?? {};
        if (event.type === "session.start" && startTime === null) {
          startTime = timestamp(event.timestamp ?? event.ts);
          const context = record(data.context) ?? {};
          startCwd = typeof context.cwd === "string" && context.cwd.trim() ? resolve(context.cwd) : null;
        } else if (event.type === "tool.execution_start" && data.toolName === "skill") {
          const args = record(data.arguments) ?? {};
          const skill = typeof args.skill === "string" ? args.skill.trim() : "";
          if (skill) invocations.push({ skill, at: timestamp(event.timestamp ?? event.ts) });
        } else if (event.type === "session.shutdown") {
          const usage = record(data.usage) ?? data;
          const details = record(data.tokenDetails) ?? {};
          const token = (category: string): unknown => record(details[category])?.tokenCount;
          const metrics: Record<Exclude<keyof UsageTotals, "totalTokens">, unknown> = {
            inputTokens: token("input") ?? usage.inputTokens,
            cachedInputTokens: token("cache_read") ?? usage.cachedInputTokens,
            cacheWriteTokens: token("cache_write") ?? usage.cacheWriteTokens,
            outputTokens: token("output") ?? usage.outputTokens,
            totalNanoAiu: data.totalNanoAiu ?? usage.totalNanoAiu,
            premiumRequests: data.totalPremiumRequests ?? usage.totalPremiumRequests ?? usage.premiumRequests,
            durationMs: data.totalApiDurationMs ?? usage.totalApiDurationMs ?? usage.sessionDurationMs ?? usage.durationMs,
          };
          shutdown = {};
          for (const [key, value] of Object.entries(metrics) as [Exclude<keyof UsageTotals, "totalTokens">, unknown][]) {
            if (value === undefined) continue;
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
              shutdown[key] = value;
            } else {
              warn("malformed_shutdown_telemetry");
            }
          }
          if ([shutdown.inputTokens, shutdown.cachedInputTokens, shutdown.cacheWriteTokens, shutdown.outputTokens].every((value) => value !== undefined)) {
            shutdown.totalTokens = shutdown.inputTokens! + shutdown.cachedInputTokens! + shutdown.cacheWriteTokens! + shutdown.outputTokens!;
          }
        }
      }
      catch {
        coverage.malformedLines++;
        warn("malformed_jsonl");
      }
    }
    const sessionTime = startTime ?? mtime;
    if (startTime === null) warn("missing_session_start");
    if (sinceMs !== null && sessionTime < sinceMs) continue;
    if (options.project === "current" && startCwd !== cwd) {
      if (!startCwd) warn("missing_start_cwd");
      continue;
    }
    coverage.sessionsMatched++;
    for (const invocation of invocations) {
      const invokedAt = invocation.at ?? sessionTime;
      const aggregate = aggregates.get(invocation.skill) ?? {
        invocations: 0,
        sessions: new Set<string>(),
        last: invokedAt,
      };
      aggregate.invocations++;
      aggregate.sessions.add(id);
      aggregate.last = Math.max(aggregate.last, invokedAt);
      aggregates.set(invocation.skill, aggregate);
      coverage.invocationsCounted++;
    }
    if (!invocations.length) continue;
    coverage.sessionsWithInvocations++;
    skillSessions++;
    const distinct = [...new Set(invocations.map(({ skill }) => skill))];
    const bucket = distinct.length === 1 ? (single.get(distinct[0]) ?? { sessions: 0, sessionsWithTelemetry: 0, totals: {}, metricSessions: {} }) : shared;
    bucket.sessions++;
    if (shutdown && Object.keys(shutdown).length) {
      telemetrySessions++;
      coverage.shutdownTelemetrySessions++;
      bucket.sessionsWithTelemetry++;
      addTotals(bucket.totals, bucket.metricSessions, shutdown);
      addTotals(totals, metricSessions, shutdown);
      if (Object.keys(shutdown).length < 8) warn("incomplete_shutdown_telemetry");
    } else warn("missing_shutdown_telemetry");
    if (distinct.length === 1) single.set(distinct[0], bucket);
  }

  const skills: HistorySkillRow[] = [];
  for (const [skill, row] of aggregates) {
    skills.push({
      skill,
      invocations: row.invocations,
      sessions: row.sessions.size,
      lastInvokedAt: new Date(row.last).toISOString(),
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    filters: {
      window: options.window,
      project: options.project,
      cwd,
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    },
    coverage,
    skills: sortSkillRows(skills),
    sessionUsage: {
      attribution: "session-level-only",
      sessions: skillSessions,
      sessionsWithTelemetry: telemetrySessions,
      totals,
      metricSessions,
      singleSkillAssociations: [...single]
        .map(([skill, bucket]) => ({ skill, ...bucket }))
        .sort((left, right) => left.skill.localeCompare(right.skill)),
      sharedSkillSessions: shared,
    },
    warnings: [...warnings]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({
        code,
        count,
        message: WARNING_MESSAGES[code]?.(count) ?? `${count} coverage warnings occurred.`,
      })),
  };
}
