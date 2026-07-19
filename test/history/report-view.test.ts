import { describe, expect, it } from "vitest";
import { formatHistoryMarkdown } from "../../src/history/format-report.js";
import { formatUkDateTime, parseHistoryReportView } from "../../src/history/report-view.js";

describe("report view helpers", () => {
  it("parses view names", () => {
    expect(parseHistoryReportView("simple")).toBe("simple");
    expect(parseHistoryReportView("advanced")).toBe("advanced");
    expect(() => parseHistoryReportView("full")).toThrow("--view accepts: simple, advanced");
  });

  it("formats UK dates from ISO", () => {
    expect(formatUkDateTime("2026-07-16T16:49:38.414Z")).toBe("16/07/2026 16:49");
    expect(formatUkDateTime(null)).toBe("—");
  });
});

describe("formatHistoryMarkdown cell escaping", () => {
  it("escapes backslashes before pipes in skill names", () => {
    const report = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-19T00:00:00.000Z",
      filters: {
        window: "7d" as const,
        project: "all" as const,
        cwd: "/repo",
        since: "2026-07-12T00:00:00.000Z",
      },
      coverage: {
        sessionsDiscovered: 1,
        sessionsRead: 1,
        sessionsMatched: 1,
        sessionsWithInvocations: 1,
        filesUnreadable: 0,
        malformedLines: 0,
        invocationsCounted: 1,
        shutdownTelemetrySessions: 0,
      },
      skills: [
        {
          skill: "evil|name\\pipe",
          invocations: 1,
          sessions: 1,
          lastInvokedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      sessionUsage: {
        attribution: "session-level-only" as const,
        sessions: 1,
        sessionsWithTelemetry: 0,
        totals: {},
        metricSessions: {},
        singleSkillAssociations: [],
        sharedSkillSessions: {
          sessions: 0,
          sessionsWithTelemetry: 0,
          totals: {},
          metricSessions: {},
        },
      },
      warnings: [],
    };
    const md = formatHistoryMarkdown(report, "simple");
    expect(md).toContain("evil\\|name\\\\pipe");
    expect(md).not.toContain("| evil|name");
  });
});
