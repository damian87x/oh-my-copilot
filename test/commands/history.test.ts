import { describe, expect, it } from "vitest";
import { formatHistory, historyCommand, parseHistoryArgs } from "../../src/commands/history.js";
import { findRegisteredCommand, registeredCommandHelpLines } from "../../src/commands/registry.js";

describe("history command", () => {
  it("is registered with the exact grammar", () => {
    expect(findRegisteredCommand("history")).toBe(historyCommand);
    expect(registeredCommandHelpLines().join("\n")).toContain("history analyze [7d|30d|90d|all] [current|all]");
  });

  it("parses defaults and strict accepted flags", () => {
    expect(parseHistoryArgs(["analyze"])).toEqual({ window: "30d", project: "all" });
    expect(parseHistoryArgs(["analyze", "--window", "7d", "--project", "current"])).toEqual({ window: "7d", project: "current" });
    expect(parseHistoryArgs(["analyze", "90d", "current"])).toEqual({ window: "90d", project: "current" });
    expect(parseHistoryArgs(["analyze", "7d", "all"])).toEqual({ window: "7d", project: "all" });
    expect(parseHistoryArgs(["analyze", "--since", "7d", "--project", "all"])).toEqual({ window: "7d", project: "all" });
    expect(() => parseHistoryArgs(["nope"])).toThrow("history supports only: analyze");
    expect(() => parseHistoryArgs(["analyze", "--window", "1d"])).toThrow("7d, 30d, 90d, all");
    expect(() => parseHistoryArgs(["analyze", "--project", "other"])).toThrow("current, all");
    expect(() => parseHistoryArgs(["analyze", "--window", "7d", "--window", "30d"])).toThrow("conflicting --window");
    expect(() => parseHistoryArgs(["analyze", "7d", "30d"])).toThrow("conflicting --window");
    expect(() => parseHistoryArgs(["analyze", "current", "all"])).toThrow("conflicting --project");
    expect(() => parseHistoryArgs(["analyze", "--window"])).toThrow("--window requires a value");
  });

  it("renders human-readable metric labels with per-metric coverage", () => {
    const report = {
      schemaVersion: 1 as const, generatedAt: "2026-07-10T00:00:00.000Z",
      filters: { window: "7d" as const, project: "all" as const, cwd: "/repo", since: "2026-07-03T00:00:00.000Z" },
      coverage: { sessionsDiscovered: 1, sessionsRead: 1, sessionsMatched: 1, sessionsWithInvocations: 1, filesUnreadable: 0, malformedLines: 0, invocationsCounted: 1, shutdownTelemetrySessions: 1 },
      skills: [], unsupportedSkills: [], warnings: [],
      sessionUsage: { attribution: "session-level-only" as const, sessions: 1, sessionsWithTelemetry: 1, totals: { inputTokens: 12, premiumRequests: 1.5 }, metricSessions: { inputTokens: 1, premiumRequests: 1 }, singleSkillAssociations: [], sharedSkillSessions: { sessions: 0, sessionsWithTelemetry: 0, totals: {}, metricSessions: {} } },
    };
    expect(formatHistory(report)).toContain("Input tokens: 12 (1 metric session)");
    expect(formatHistory(report)).toContain("Premium requests: 1.5 (1 metric session)");
  });

  it("returns JSON, text, and structured errors from historyCommand.run", () => {
    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-missing-history-command-home";
    try {
      const json = historyCommand.run(["analyze", "--json"], { cwd: "/repo", json: true });
      expect(json).toMatchObject({ ok: true, output: { schemaVersion: 1, filters: { window: "30d", project: "all" } } });
      const text = historyCommand.run(["analyze"], { cwd: "/repo", json: false });
      expect(text).toMatchObject({ ok: true });
      expect((text as { message: string }).message).toContain("Skill history (30d, project=all)");
      expect(historyCommand.run(["nope"], { cwd: "/repo", json: false })).toEqual({ ok: false, exitCode: 1, message: "history supports only: analyze" });
      expect(historyCommand.run(["nope"], { cwd: "/repo", json: true })).toEqual({ ok: false, exitCode: 1, message: "history supports only: analyze" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  });
});
