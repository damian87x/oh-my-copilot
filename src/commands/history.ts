import { analyzeHistory, type HistoryAnalysis, type HistoryProjectScope, type HistoryWindow, type UsageBucket } from "../history/analyze.js";
import type { CliResult, CommandModule } from "./types.js";

const WINDOWS = ["7d", "30d", "90d", "all"] as const;
const PROJECTS = ["current", "all"] as const;
const METRIC_LABELS: Record<string, string> = {
  inputTokens: "Input tokens",
  cachedInputTokens: "Cached input tokens",
  cacheWriteTokens: "Cache write tokens",
  outputTokens: "Output tokens",
  totalTokens: "Total tokens",
  totalNanoAiu: "AI credits (nano-AIU)",
  premiumRequests: "Premium requests",
  durationMs: "API duration (ms)",
};

interface SkillSummaryRow {
  skill: string;
  invocations: number;
  sessions: number;
  lastInvokedAt: string;
}

function formatSkillRows(rows: SkillSummaryRow[]): string {
  if (rows.length === 0) return "  (none)";
  return rows
    .map((row) => `  ${row.skill}\t${row.invocations}\t${row.sessions}\t${row.lastInvokedAt}`)
    .join("\n");
}

function formatUsageTotals(bucket: UsageBucket): string {
  const rows = Object.entries(bucket.totals)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const sessions = bucket.metricSessions[key as keyof typeof bucket.metricSessions] ?? 0;
      const label = METRIC_LABELS[key] ?? key;
      const suffix = sessions === 1 ? "" : "s";
      return `  ${label}: ${value} (${sessions} metric session${suffix})`;
    });
  return rows.join("\n") || "  (none)";
}

export function parseHistoryArgs(argv: string[]): { window: HistoryWindow; project: HistoryProjectScope } {
  const args = argv[0] === "history" ? argv.slice(1) : argv;
  if (args[0] !== "analyze") throw new Error("history supports only: analyze");
  let window: HistoryWindow = "30d";
  let project: HistoryProjectScope = "all";
  const seen = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") continue;
    const hasExplicitScope = seen.has("--window") || seen.has("--project");
    const isPositionalWindow = WINDOWS.includes(flag as HistoryWindow) && !(flag === "all" && hasExplicitScope);
    if (isPositionalWindow) {
      if (seen.has("--window") && seen.get("--window") !== flag) {
        throw new Error("conflicting --window values");
      }
      seen.set("--window", flag);
      window = flag as HistoryWindow;
      continue;
    }
    if (PROJECTS.includes(flag as HistoryProjectScope)) {
      if (seen.has("--project") && seen.get("--project") !== flag) {
        throw new Error("conflicting --project values");
      }
      seen.set("--project", flag);
      project = flag as HistoryProjectScope;
      continue;
    }
    if (flag !== "--window" && flag !== "--since" && flag !== "--project") {
      throw new Error(`unexpected history argument: ${flag}`);
    }
    const value = args[++i];
    const canonical = flag === "--since" ? "--window" : flag;
    if (!value || value.startsWith("--")) {
      const accepted = canonical === "--window" ? WINDOWS : PROJECTS;
      throw new Error(`${flag} requires a value; accepted: ${accepted.join(", ")}`);
    }
    if (seen.has(canonical) && seen.get(canonical) !== value) {
      throw new Error(`conflicting ${canonical} values`);
    }
    seen.set(canonical, value);
    if (canonical === "--window") {
      if (!WINDOWS.includes(value as HistoryWindow)) {
        throw new Error(`${flag} accepts: ${WINDOWS.join(", ")}`);
      }
      window = value as HistoryWindow;
    } else {
      if (!PROJECTS.includes(value as HistoryProjectScope)) {
        throw new Error(`--project accepts: ${PROJECTS.join(", ")}`);
      }
      project = value as HistoryProjectScope;
    }
  }
  return { window, project };
}

export function formatHistory(report: HistoryAnalysis): string {
  const supported = formatSkillRows(report.skills);
  const unsupported = formatSkillRows(report.unsupportedSkills);
  const warningText = report.warnings.length
    ? report.warnings.map((warning) => `  [${warning.code}] ${warning.message}`).join("\n")
    : "  (none)";
  const associations = report.sessionUsage.singleSkillAssociations.length
    ? report.sessionUsage.singleSkillAssociations
        .map(
          (row) =>
            `  ${row.skill}: ${row.sessions} sessions (${row.sessionsWithTelemetry} with telemetry)\n${formatUsageTotals(row)}`,
        )
        .join("\n")
    : "  (none)";
  const shared = report.sessionUsage.sharedSkillSessions;
  return `Skill history (${report.filters.window}, project=${report.filters.project})\nSupported benchmark skills:\n${supported}\nUnsupported observed skills:\n${unsupported}\nCoverage: ${report.coverage.sessionsMatched}/${report.coverage.sessionsDiscovered} sessions matched; ${report.coverage.invocationsCounted} invocations counted.\nUsage attribution: session-level-only; totals cover whole skill sessions and are not per-skill.\nAll skill-session totals (${report.sessionUsage.sessions} sessions, ${report.sessionUsage.sessionsWithTelemetry} with telemetry):\n${formatUsageTotals(report.sessionUsage)}\nSingle-skill associations:\n${associations}\nShared skill sessions: ${shared.sessions} sessions (${shared.sessionsWithTelemetry} with telemetry)\n${formatUsageTotals(shared)}\nWarnings:\n${warningText}`;
}

export const historyCommand: CommandModule = {
  name: "history",
  summary: "history analyze [7d|30d|90d|all] [current|all] [--window/--since WINDOW] [--project SCOPE] [--json]",
  run(argv, context): CliResult {
    try {
      const args = parseHistoryArgs(argv);
      const report = analyzeHistory({ ...args, cwd: context.cwd });
      return context.json ? { ok: true, output: report } : { ok: true, message: formatHistory(report) };
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
