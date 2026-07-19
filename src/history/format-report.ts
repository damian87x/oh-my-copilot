import type { HistoryAnalysis, UsageBucket } from "./analyze.js";
import {
  nanoAiuToAiCredits,
  type HistorySpendEstimates,
} from "./cost-estimate.js";
import { formatUkDateTime, type HistoryReportView } from "./report-view.js";

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

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_(none)_";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}`;
}

function cell(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return "—";
  // Escape backslashes first so a trailing `\` cannot undo the pipe escape.
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function formatUsageRows(bucket: UsageBucket): string[][] {
  return Object.entries(bucket.totals)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const sessions = bucket.metricSessions[key as keyof typeof bucket.metricSessions] ?? 0;
      return [METRIC_LABELS[key] ?? key, cell(value), cell(sessions)];
    });
}

/** Simple-mode API usage: tokens + AI credits always when telemetry exists. */
function compactApiUsageRows(
  totals: UsageBucket["totals"],
  estimates: HistorySpendEstimates | undefined,
): string[][] {
  const rows: string[][] = [];
  const aiCredits =
    estimates?.aiCredits ??
    (totals.totalNanoAiu !== undefined ? nanoAiuToAiCredits(totals.totalNanoAiu) : undefined);
  if (aiCredits !== undefined) rows.push(["AI credits", cell(aiCredits)]);
  if (totals.totalNanoAiu !== undefined) {
    rows.push(["AI credits (nano-AIU)", cell(totals.totalNanoAiu)]);
  }
  for (const key of [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "premiumRequests",
    "durationMs",
  ] as const) {
    if (totals[key] !== undefined) {
      rows.push([METRIC_LABELS[key] ?? key, cell(totals[key])]);
    }
  }
  return rows;
}

function byModelSimple(estimates: HistorySpendEstimates | undefined): string {
  if (!estimates?.byModel.length) {
    return "### By model (API usage)\n\n_(none)_";
  }
  // Always show API token usage + AI credits. Public $ only when --price public matched.
  const rows = estimates.byModel.map((row) => [
    cell(row.model),
    cell(row.inputTokens),
    cell(row.outputTokens),
    cell(row.cacheReadTokens),
    cell(row.cacheWriteTokens),
    cell(row.aiCredits),
    cell(row.estimatedUsdFromPublicRates),
  ]);
  const hasPublicUsd = estimates.byModel.some(
    (row) => row.estimatedUsdFromPublicRates !== undefined,
  );
  const note = hasPublicUsd
    ? `_API usage from session telemetry. USD column uses public model rates when available._`
    : `_API usage from session telemetry (always). USD is — until you ask for **dollar estimates** (public pricing)._`;
  return [
    "### By model (API usage)",
    "",
    mdTable(
      [
        "Model",
        "Input tokens",
        "Output tokens",
        "Cached tokens",
        "Cache write",
        "AI credits",
        "USD (public rates)",
      ],
      rows,
    ),
    "",
    note,
  ].join("\n");
}

function byModelAdvanced(estimates: HistorySpendEstimates | undefined): string {
  if (!estimates) {
    return "### By model\n\n_(none — no nano-AIU telemetry in skill sessions)_";
  }
  const summaryRows: string[][] = [
    ["Source", cell(estimates.source)],
    ["AI credits", cell(estimates.aiCredits)],
  ];
  if (estimates.pricing) {
    summaryRows.push(
      ["Public pricing attempted", cell(estimates.pricing.attempted ? "yes" : "no")],
      ["Pricing URL", cell(estimates.pricing.sourceUrl)],
      ["Retrieved at", cell(formatUkDateTime(estimates.pricing.retrievedAt))],
      ["Matched models", cell(estimates.pricing.matchedModels.join(", ") || "—")],
      ["Unresolved models", cell(estimates.pricing.unresolvedModels.join(", ") || "—")],
    );
  }
  const modelRows = estimates.byModel.map((row) => [
    cell(row.model),
    cell(row.totalNanoAiu),
    cell(row.aiCredits),
    cell(row.inputTokens),
    cell(row.outputTokens),
    cell(row.estimatedUsdFromPublicRates),
  ]);
  const lines = [
    "### Spend & models",
    "",
    mdTable(["Field", "Value"], summaryRows),
    "",
    `_${estimates.disclaimer}_`,
  ];
  if (modelRows.length) {
    lines.push(
      "",
      "#### By model",
      "",
      mdTable(
        ["Model", "nano-AIU", "AI credits", "Input tokens", "Output tokens", "USD (public rates)"],
        modelRows,
      ),
    );
  }
  return lines.join("\n");
}

function formatSimple(report: HistoryAnalysis): string {
  const { filters, coverage, skills, sessionUsage } = report;
  const skillRows = skills.map((row, index) => [
    cell(index + 1),
    cell(row.skill),
    cell(row.invocations),
    cell(row.sessions),
    cell(formatUkDateTime(row.lastInvokedAt)),
  ]);
  const associationRows = sessionUsage.singleSkillAssociations.map((row) => [
    cell(row.skill),
    cell(row.sessions),
    cell(row.sessionsWithTelemetry),
  ]);
  const usageRows = compactApiUsageRows(sessionUsage.totals, sessionUsage.estimates);

  return [
    `## Skill history — simple (${filters.window}, project=${filters.project})`,
    "",
    "### Snapshot",
    "",
    mdTable(
      ["Field", "Value"],
      [
        ["Window", cell(filters.window)],
        ["Project", cell(filters.project)],
        ["Since", cell(formatUkDateTime(filters.since))],
        ["Skill invocations", cell(coverage.invocationsCounted)],
        ["Skills used", cell(skills.length)],
        ["Sessions with skills", cell(coverage.sessionsWithInvocations)],
        ["Sessions matched / discovered", `${coverage.sessionsMatched} / ${coverage.sessionsDiscovered}`],
      ],
    ),
    "",
    "### Top skills",
    "",
    mdTable(["#", "Skill", "Times used", "Sessions", "Last invoked (UK)"], skillRows),
    "",
    "### API usage",
    "",
    `_Session-level totals only (not per-skill). AI credits always included when telemetry exists._`,
    "",
    mdTable(
      ["Metric", "Total"],
      usageRows.length ? usageRows : [["API usage", "—"]],
    ),
    "",
    byModelSimple(sessionUsage.estimates),
    "",
    "### Single-skill associations",
    "",
    mdTable(["Skill", "Sessions", "With telemetry"], associationRows),
  ].join("\n");
}

function formatAdvanced(report: HistoryAnalysis): string {
  const { filters, coverage, skills, sessionUsage, warnings } = report;
  const skillRows = skills.map((row, index) => [
    cell(index + 1),
    cell(row.skill),
    cell(row.invocations),
    cell(row.sessions),
    cell(formatUkDateTime(row.lastInvokedAt)),
  ]);
  const associationRows = sessionUsage.singleSkillAssociations.map((row) => [
    cell(row.skill),
    cell(row.sessions),
    cell(row.sessionsWithTelemetry),
  ]);
  const shared = sessionUsage.sharedSkillSessions;
  const warningRows = warnings.map((warning) => [
    cell(warning.code),
    cell(warning.count),
    cell(warning.message),
  ]);

  return [
    `## Skill history — advanced (${filters.window}, project=${filters.project})`,
    "",
    "### Window & coverage",
    "",
    mdTable(
      ["Field", "Value"],
      [
        ["Window", cell(filters.window)],
        ["Project", cell(filters.project)],
        ["Since", cell(formatUkDateTime(filters.since))],
        ["Generated", cell(formatUkDateTime(report.generatedAt))],
        ["Sessions matched / discovered", `${coverage.sessionsMatched} / ${coverage.sessionsDiscovered}`],
        ["Sessions with skill invocations", cell(coverage.sessionsWithInvocations)],
        ["Invocations counted", cell(coverage.invocationsCounted)],
        ["Skill sessions with telemetry", cell(coverage.shutdownTelemetrySessions)],
      ],
    ),
    "",
    "### Top skills",
    "",
    mdTable(["#", "Skill", "Times used", "Sessions", "Last invoked (UK)"], skillRows),
    "",
    "### Session-level usage",
    "",
    `_Attribution: **session-level-only** — totals cover whole skill sessions and are not per-skill._`,
    "",
    `Skill sessions: **${sessionUsage.sessions}** (${sessionUsage.sessionsWithTelemetry} with telemetry)`,
    "",
    mdTable(["Metric", "Total", "Metric sessions"], formatUsageRows(sessionUsage)),
    "",
    byModelAdvanced(sessionUsage.estimates),
    "",
    "### Single-skill associations",
    "",
    mdTable(["Skill", "Sessions", "With telemetry"], associationRows),
    "",
    "### Shared skill sessions",
    "",
    `Shared sessions: **${shared.sessions}** (${shared.sessionsWithTelemetry} with telemetry)`,
    "",
    mdTable(["Metric", "Total", "Metric sessions"], formatUsageRows(shared)),
    "",
    "### Warnings",
    "",
    mdTable(["Code", "Count", "Message"], warningRows),
  ].join("\n");
}

/**
 * Friendly markdown report. Default view is **simple**.
 * Numeric values are copied exactly (no rounding/rescaling).
 * Dates use UK DD/MM/YYYY HH:mm (UTC). USD (credits) is never shown.
 */
export function formatHistoryMarkdown(
  report: HistoryAnalysis,
  view: HistoryReportView = "simple",
): string {
  return view === "advanced" ? formatAdvanced(report) : formatSimple(report);
}
