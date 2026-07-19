import { describe, expect, it } from "vitest";
import type { HistoryAnalysis } from "../../src/history/analyze.js";
import { formatHistoryHtml } from "../../src/history/format-html.js";

const sample: HistoryAnalysis = {
  schemaVersion: 1,
  generatedAt: "2026-07-10T00:00:00.000Z",
  filters: {
    window: "14d",
    project: "all",
    cwd: "/repo",
    since: "2026-06-26T00:00:00.000Z",
  },
  coverage: {
    sessionsDiscovered: 10,
    sessionsRead: 9,
    sessionsMatched: 5,
    sessionsWithInvocations: 2,
    filesUnreadable: 0,
    malformedLines: 0,
    invocationsCounted: 3,
    shutdownTelemetrySessions: 1,
  },
  skills: [
    {
      skill: "tdd",
      invocations: 2,
      sessions: 1,
      lastInvokedAt: "2026-07-09T12:00:00.000Z",
    },
  ],
  warnings: [{ code: "missing_shutdown_telemetry", count: 1, message: "missing" }],
  sessionUsage: {
    attribution: "session-level-only",
    sessions: 2,
    sessionsWithTelemetry: 1,
    totals: { inputTokens: 100, totalNanoAiu: 1_000_000_000 },
    metricSessions: { inputTokens: 1, totalNanoAiu: 1 },
    singleSkillAssociations: [
      {
        skill: "tdd",
        sessions: 1,
        sessionsWithTelemetry: 1,
        totals: { inputTokens: 100 },
        metricSessions: { inputTokens: 1 },
      },
    ],
    sharedSkillSessions: {
      sessions: 1,
      sessionsWithTelemetry: 0,
      totals: {},
      metricSessions: {},
    },
    estimates: {
      source: "session-shutdown-nano-aiu",
      aiCredits: 1,
      estimatedUsdFromCredits: 0.01,
      byModel: [
        {
          model: "gpt-5-mini",
          totalNanoAiu: 1_000_000_000,
          aiCredits: 1,
          estimatedUsdFromCredits: 0.01,
        },
      ],
      disclaimer: "estimate only; not a provider invoice; session-level-only (not per-skill)",
    },
  },
};

describe("formatHistoryHtml", () => {
  it("renders a self-contained HTML report with tables and escaped content", () => {
    const html = formatHistoryHtml(sample);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Skill history — simple (14d, project=all)");
    expect(html).toContain("<th>#</th>");
    expect(html).toContain("<td>tdd</td>");
    expect(html).toContain("gpt-5-mini");
    // Simple HTML now surfaces coverage warnings (not only advanced).
    expect(html).toContain("missing_shutdown_telemetry");
    expect(html).toContain("Skill sessions with telemetry");
    expect(html).toContain("session-level-only");
    expect(html).not.toContain("<script>");
    expect(html).toContain("simple");
    expect(html).toContain("Times used");
    expect(html).not.toMatch(/<th>USD \(credits\)<\/th>/);
    expect(html).not.toContain("Session-level usage");
  });

  it("advanced view includes session usage and warnings without credit USD", () => {
    const html = formatHistoryHtml(sample, "advanced");
    expect(html).toContain("advanced");
    expect(html).toContain("Session-level usage");
    expect(html).toContain("Warnings");
    expect(html).not.toMatch(/<th>USD \(credits\)<\/th>/);
  });
});
