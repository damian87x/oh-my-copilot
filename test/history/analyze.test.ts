import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../../src/history/analyze.js";

const now = new Date("2026-07-10T22:02:22.000Z");

function session(root: string, id: string, events: unknown[], malformed = false): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => JSON.stringify(event));
  if (malformed) lines.splice(1, 0, "{not json");
  writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
}

describe("analyzeHistory", () => {
  it.each([
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
  ] as const)("uses inclusive %s boundaries and excludes the preceding millisecond", (window, days) => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    const boundary = new Date(now.getTime() - days * 86400000).toISOString();
    const outside = new Date(now.getTime() - days * 86400000 - 1).toISOString();
    session(root, `boundary-${days}`, [
      { type: "session.start", timestamp: boundary, data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: boundary, data: { toolName: "skill", arguments: { skill: "tdd" } } },
    ]);
    session(root, `outside-${days}`, [
      { type: "session.start", timestamp: outside, data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: outside, data: { toolName: "skill", arguments: { skill: "ralplan" } } },
    ]);
    const report = analyzeHistory({ window, project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.skills.map(({ skill }) => skill)).toEqual(["tdd"]);
  });

  it("includes every timestamp for all", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "ancient-session", [
      { type: "session.start", timestamp: "2000-01-01T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "ralplan" } } },
    ]);
    expect(analyzeHistory({ window: "all", project: "all", cwd: "/repo", sessionStateDir: root, now }).skills[0]?.skill).toBe("ralplan");
  });

  it("ranks arbitrary observed skills without benchmark task metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "debug-session", [
      { type: "session.start", timestamp: "2026-07-09T10:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: "2026-07-09T11:00:00Z", data: { toolName: "skill", arguments: { skill: "debug" } } },
      { type: "tool.execution_start", timestamp: "2026-07-09T12:00:00Z", data: { toolName: "skill", arguments: { skill: "arbitrary-local-skill" } } },
      { type: "tool.execution_start", timestamp: "2026-07-09T13:00:00Z", data: { toolName: "skill", arguments: { skill: "arbitrary-local-skill" } } },
    ]);

    const report = analyzeHistory({
      window: "30d", project: "all", cwd: "/repo", sessionStateDir: root, now,
    });

    expect(report.skills).toEqual([
      { skill: "arbitrary-local-skill", invocations: 2, sessions: 1, lastInvokedAt: "2026-07-09T13:00:00.000Z" },
      { skill: "debug", invocations: 1, sessions: 1, lastInvokedAt: "2026-07-09T11:00:00.000Z" },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/benchmarkable|benchmarkTask|debug-inflight-dedup/);
  });

  it("counts only exact skill tool starts, tolerates malformed lines, and never leaks content", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "valid-session", [
      { type: "session.start", timestamp: "2026-07-09T10:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "user.message", data: { content: "SECRET /tdd" } },
      { type: "session.skills_loaded", data: { skills: ["tdd"] } },
      { type: "tool.execution_start", timestamp: "2026-07-09T11:00:00Z", data: { toolName: "skill", arguments: { skill: "code-review" } } },
      { type: "tool.execution_complete", timestamp: "2026-07-09T11:01:00Z", data: { toolName: "skill", arguments: { skill: "tdd" }, content: "SECRET" } },
      { type: "tool.execution_start", data: { toolName: "Skill", arguments: { skill: "tdd" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "  " } } },
    ], true);

    const report = analyzeHistory({ window: "30d", project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.coverage.invocationsCounted).toBe(1);
    expect(report.skills).toEqual([{ skill: "code-review", invocations: 1, sessions: 1, lastInvokedAt: "2026-07-09T11:00:00.000Z" }]);
    expect(JSON.stringify(report)).not.toMatch(/benchmarkable|benchmarkTask|code-review-sqli/);
    expect(report.coverage.malformedLines).toBe(1);
    expect(JSON.stringify(report)).not.toContain("SECRET");
  });

  it("filters exact current cwd, sorts supported and unsupported rows, and keeps telemetry session-level", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "session-a", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: "2026-07-10T01:00:00Z", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "tool.execution_start", timestamp: "2026-07-10T02:00:00Z", data: { toolName: "skill", arguments: { skill: "research-codebase" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 100, outputTokens: 20, totalNanoAiu: 9, durationMs: 50 } } },
    ]);
    session(root, "session-b", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo-child" } } },
      { type: "tool.execution_start", timestamp: "2026-07-10T03:00:00Z", data: { toolName: "skill", arguments: { skill: "ralplan" } } },
    ]);
    const report = analyzeHistory({ window: "7d", project: "current", cwd: "/repo", sessionStateDir: root, now });
    expect(report.skills.map((row) => row.skill)).toEqual(["research-codebase", "tdd"]);
    expect(report.coverage.sessionsMatched).toBe(1);
    expect(report.sessionUsage).toMatchObject({ attribution: "session-level-only", sessions: 1, sessionsWithTelemetry: 1, totals: { inputTokens: 100, outputTokens: 20, totalNanoAiu: 9, durationMs: 50 }, sharedSkillSessions: { sessions: 1, sessionsWithTelemetry: 1 } });
    expect(report.skills[0]).not.toHaveProperty("inputTokens");
  });

  it("matches only the exact current cwd, excluding siblings and warning for missing cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    for (const [id, cwd] of [["exact-cwd", "/repo"], ["sibling-cwd", "/repo-sibling"], ["missing-cwd", undefined]] as const) {
      session(root, id, [
        { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: cwd ? { cwd } : {} } },
        { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      ]);
    }
    const report = analyzeHistory({ window: "7d", project: "current", cwd: "/repo", sessionStateDir: root, now });
    expect(report.coverage.sessionsMatched).toBe(1);
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "missing_start_cwd", count: 1 }));
  });

  it("returns an empty warned report for a missing root and null since for all", () => {
    const report = analyzeHistory({ window: "all", project: "all", cwd: "/repo", sessionStateDir: join(tmpdir(), "definitely-missing-omp-history"), now });
    expect(report.filters.since).toBeNull();
    expect(report.coverage.sessionsDiscovered).toBe(0);
    expect(report.warnings.map((warning) => warning.code)).toContain("session_state_missing");
  });

  it("maps the real Copilot shutdown tokenDetails and API duration shape", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "real-shutdown", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: "2026-07-10T01:00:00Z", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      {
        type: "session.shutdown",
        data: {
          tokenDetails: {
            input: { tokenCount: 101 },
            cache_read: { tokenCount: 202 },
            cache_write: { tokenCount: 303 },
            output: { tokenCount: 404 },
          },
          totalNanoAiu: 505,
          totalApiDurationMs: 606,
          currentModel: "must-not-be-emitted",
          modelMetrics: { secret: "must-not-be-emitted" },
        },
      },
    ]);

    const report = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.sessionUsage.totals).toEqual({
      inputTokens: 101,
      cachedInputTokens: 202,
      cacheWriteTokens: 303,
      outputTokens: 404,
      totalNanoAiu: 505,
      totalTokens: 1010,
      durationMs: 606,
    });
    expect(JSON.stringify(report)).not.toContain("must-not-be-emitted");
  });

  it("retains only the final cumulative shutdown and excludes zero-skill telemetry", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "skill-session", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4 } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 30, outputTokens: 40 }, totalPremiumRequests: 5, totalApiDurationMs: 60 } },
    ]);
    session(root, "no-skill", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 999 } } },
    ]);
    const usage = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now }).sessionUsage;
    expect(usage.totals).toEqual({ inputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 30, outputTokens: 40, totalTokens: 100, premiumRequests: 5, durationMs: 60 });
    expect(usage.singleSkillAssociations).toEqual([{ skill: "tdd", sessions: 1, sessionsWithTelemetry: 1, totals: usage.totals, metricSessions: usage.metricSessions }]);
    expect(usage.sharedSkillSessions.sessions).toBe(0);
  });

  it("tracks coverage per metric, derives total tokens only from complete token telemetry, and stabilizes decimals", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "complete", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, premiumRequests: 103.12, sessionDurationMs: 2100 } } },
    ]);
    session(root, "partial", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: 5, premiumRequests: 0.33 } } },
    ]);
    session(root, "missing", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
    ]);

    const report = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.sessionUsage.totals).toMatchObject({ inputTokens: 6, totalTokens: 10, premiumRequests: 103.45, durationMs: 2100 });
    expect(report.sessionUsage.metricSessions).toEqual({ inputTokens: 2, cachedInputTokens: 1, cacheWriteTokens: 1, outputTokens: 1, totalTokens: 1, premiumRequests: 2, durationMs: 1 });
    expect(report.sessionUsage.singleSkillAssociations[0].metricSessions).toEqual(report.sessionUsage.metricSessions);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "incomplete_shutdown_telemetry", count: 2 }),
      expect.objectContaining({ code: "missing_shutdown_telemetry", count: 1 }),
    ]));
  });

  it("keeps single and shared telemetry non-overlapping", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "single-only", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "session.shutdown", data: { usage: { premiumRequests: 1 } } },
    ]);
    session(root, "shared-only", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "ralplan" } } },
      { type: "session.shutdown", data: { usage: { premiumRequests: 2 } } },
    ]);
    const usage = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now }).sessionUsage;
    expect(usage.totals.premiumRequests).toBe(3);
    expect(usage.singleSkillAssociations.find(({ skill }) => skill === "tdd")?.totals.premiumRequests).toBe(1);
    expect(usage.sharedSkillSessions.totals.premiumRequests).toBe(2);
  });

  it("coalesces malformed telemetry, skips invalid session ids, and rejects a non-directory root", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "valid-telemetry", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      { type: "session.shutdown", data: { usage: { inputTokens: -1, outputTokens: "bad" } } },
    ]);
    session(root, "invalid id!", []);
    const report = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "malformed_shutdown_telemetry", count: 2 }));
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: "invalid_session_id", count: 1 }));

    const file = join(mkdtempSync(join(tmpdir(), "omp-history-file-")), "not-a-directory");
    writeFileSync(file, "x");
    expect(() => analyzeHistory({ window: "all", project: "all", cwd: "/repo", sessionStateDir: file, now })).toThrow("session-state path is not a directory");
  });
});

  it("accepts free-form day windows including 14d and 365d", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    const inside14 = new Date(now.getTime() - 10 * 86400000).toISOString();
    const outside14 = new Date(now.getTime() - 20 * 86400000).toISOString();
    session(root, "inside-14", [
      { type: "session.start", timestamp: inside14, data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: inside14, data: { toolName: "skill", arguments: { skill: "tdd" } } },
    ]);
    session(root, "outside-14", [
      { type: "session.start", timestamp: outside14, data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: outside14, data: { toolName: "skill", arguments: { skill: "ralplan" } } },
    ]);
    expect(analyzeHistory({ window: "14d", project: "all", cwd: "/repo", sessionStateDir: root, now }).skills.map((r) => r.skill)).toEqual(["tdd"]);
    expect(analyzeHistory({ window: "365d", project: "all", cwd: "/repo", sessionStateDir: root, now }).skills.map((r) => r.skill).sort()).toEqual(["ralplan", "tdd"]);
  });

  it("builds credit-based spend estimates and model metrics without leaking secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "priced-session", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", timestamp: "2026-07-10T01:00:00Z", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      {
        type: "session.shutdown",
        data: {
          totalNanoAiu: 2_000_000_000,
          tokenDetails: {
            input: { tokenCount: 100 },
            cache_read: { tokenCount: 0 },
            cache_write: { tokenCount: 0 },
            output: { tokenCount: 50 },
          },
          modelMetrics: {
            "gpt-5-mini": {
              usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
              totalNanoAiu: 2_000_000_000,
            },
            secret: "must-not-be-emitted",
          },
        },
      },
    ]);
    const report = analyzeHistory({ window: "7d", project: "all", cwd: "/repo", sessionStateDir: root, now });
    expect(report.sessionUsage.estimates).toMatchObject({
      source: "session-shutdown-nano-aiu",
      aiCredits: 2,
      estimatedUsdFromCredits: 0.02,
      disclaimer: expect.stringContaining("session-level-only"),
    });
    expect(report.sessionUsage.estimates?.byModel).toEqual([
      expect.objectContaining({
        model: "gpt-5-mini",
        inputTokens: 100,
        outputTokens: 50,
        totalNanoAiu: 2_000_000_000,
        aiCredits: 2,
        estimatedUsdFromCredits: 0.02,
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("must-not-be-emitted");
  });

  it("applies public pricing rates when provided", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-history-"));
    session(root, "public-price-session", [
      { type: "session.start", timestamp: "2026-07-10T00:00:00Z", data: { context: { cwd: "/repo" } } },
      { type: "tool.execution_start", data: { toolName: "skill", arguments: { skill: "tdd" } } },
      {
        type: "session.shutdown",
        data: {
          totalNanoAiu: 1_000_000_000,
          modelMetrics: {
            "gpt-5-mini": {
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
              totalNanoAiu: 1_000_000_000,
            },
            "unknown-model": {
              usage: { inputTokens: 10, outputTokens: 10 },
              totalNanoAiu: 1,
            },
          },
        },
      },
    ]);
    const report = analyzeHistory({
      window: "7d",
      project: "all",
      cwd: "/repo",
      sessionStateDir: root,
      now,
      publicPricing: {
        source: "public-github-copilot-model-pricing",
        url: "https://example.test/pricing",
        retrievedAt: "2026-07-10T00:00:00.000Z",
        currency: "USD",
        completeness: "unambiguous-model-rates",
        models: {
          "gpt-5-mini": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        },
      },
    });
    expect(report.sessionUsage.estimates?.source).toBe("session-shutdown-nano-aiu+public-pricing");
    expect(report.sessionUsage.estimates?.pricing).toMatchObject({
      attempted: true,
      matchedModels: ["gpt-5-mini"],
      unresolvedModels: ["unknown-model"],
      sourceUrl: "https://example.test/pricing",
    });
    const mini = report.sessionUsage.estimates?.byModel.find((row) => row.model === "gpt-5-mini");
    expect(mini?.estimatedUsdFromPublicRates).toBe(3);
  });
