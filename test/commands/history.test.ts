import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultHtmlReportPath,
  formatHistory,
  historyCommand,
  parseHistoryArgs,
  resolveHtmlPath,
  writeHistoryHtmlReport,
} from "../../src/commands/history.js";
import { findRegisteredCommand, registeredCommandHelpLines } from "../../src/commands/registry.js";
import type { HistoryAnalysis } from "../../src/history/analyze.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("history command", () => {
  it("is registered with the exact grammar", () => {
    expect(findRegisteredCommand("history")).toBe(historyCommand);
    expect(registeredCommandHelpLines().join("\n")).toContain("history analyze");
    expect(registeredCommandHelpLines().join("\n")).toContain("--days N");
    expect(registeredCommandHelpLines().join("\n")).toContain("--price public");
    expect(registeredCommandHelpLines().join("\n")).toContain("--html");
  });

  it("parses defaults and strict accepted flags", () => {
    expect(parseHistoryArgs(["analyze"])).toEqual({
      window: "30d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "--window", "7d", "--project", "current"])).toEqual({
      window: "7d",
      project: "current",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "90d", "current"])).toEqual({
      window: "90d",
      project: "current",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "14d"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "--days", "14", "current"])).toEqual({
      window: "14d",
      project: "current",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "--days", "365", "--price", "public"])).toEqual({
      window: "365d",
      project: "all",
      price: "public",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "14d", "--view", "advanced"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "advanced",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseHistoryArgs(["analyze", "14d", "advanced", "--html"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "advanced",
      htmlPath: null,
      htmlDefault: true,
    });
    expect(parseHistoryArgs(["analyze", "14d", "--html"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: true,
    });
    expect(parseHistoryArgs(["analyze", "14d", "--html", "out/report.html"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: "out/report.html",
      htmlDefault: false,
    });
    expect(() => parseHistoryArgs(["nope"])).toThrow("history supports only: analyze");
    expect(() => parseHistoryArgs(["analyze", "--window", "0d"])).toThrow(/1\.\.365|Nd/);
    expect(() => parseHistoryArgs(["analyze", "--window", "366d"])).toThrow(/1\.\.365|Nd/);
    expect(() => parseHistoryArgs(["analyze", "--days", "0"])).toThrow("--days requires an integer 1..365");
    expect(() => parseHistoryArgs(["analyze", "--project", "other"])).toThrow("current, all");
    expect(() => parseHistoryArgs(["analyze", "--window", "7d", "--window", "30d"])).toThrow(
      "conflicting --window",
    );
    expect(() => parseHistoryArgs(["analyze", "7d", "30d"])).toThrow("conflicting --window");
    expect(() => parseHistoryArgs(["analyze", "current", "all"])).toThrow("conflicting --project");
    expect(() => parseHistoryArgs(["analyze", "--window"])).toThrow("--window requires a value");
    expect(() => parseHistoryArgs(["analyze", "--price", "nope"])).toThrow("--price accepts: public, none");
  });

  it("resolves default and explicit HTML paths", () => {
    const def = defaultHtmlReportPath("/repo", "14d", new Date("2026-07-17T12:34:56.000Z"));
    expect(def).toContain("/repo/.omp/reports/skill-retro-14d-");
    expect(def.endsWith(".html")).toBe(true);
    expect(resolveHtmlPath("/repo", "14d", null, false)).toBeNull();
    expect(resolveHtmlPath("/repo", "14d", null, true, new Date("2026-07-17T12:34:56.000Z"))).toBe(
      def,
    );
    expect(resolveHtmlPath("/repo", "14d", "out.html", false)).toBe("/repo/out.html");
  });

  it("writes an HTML report file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-history-html-"));
    tempDirs.push(dir);
    const path = join(dir, "report.html");
    const report: HistoryAnalysis = {
      schemaVersion: 1,
      generatedAt: "2026-07-10T00:00:00.000Z",
      filters: { window: "7d", project: "all", cwd: "/repo", since: "2026-07-03T00:00:00.000Z" },
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
          skill: "tdd",
          invocations: 1,
          sessions: 1,
          lastInvokedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      warnings: [],
      sessionUsage: {
        attribution: "session-level-only",
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
    };
    writeHistoryHtmlReport(path, report);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("tdd");
  });

  it("renders human-readable metric labels with per-metric coverage", () => {
    const report = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-10T00:00:00.000Z",
      filters: {
        window: "7d",
        project: "all" as const,
        cwd: "/repo",
        since: "2026-07-03T00:00:00.000Z",
      },
      coverage: {
        sessionsDiscovered: 1,
        sessionsRead: 1,
        sessionsMatched: 1,
        sessionsWithInvocations: 1,
        filesUnreadable: 0,
        malformedLines: 0,
        invocationsCounted: 1,
        shutdownTelemetrySessions: 1,
      },
      skills: [],
      warnings: [],
      sessionUsage: {
        attribution: "session-level-only" as const,
        sessions: 1,
        sessionsWithTelemetry: 1,
        totals: { inputTokens: 12, premiumRequests: 1.5 },
        metricSessions: { inputTokens: 1, premiumRequests: 1 },
        singleSkillAssociations: [],
        sharedSkillSessions: {
          sessions: 0,
          sessionsWithTelemetry: 0,
          totals: {},
          metricSessions: {},
        },
      },
    };
    const formatted = formatHistory(report);
    expect(formatted).toContain("### Top skills");
    expect(formatted).toContain("simple");
    expect(formatted).toContain("### API usage");
    expect(formatted).not.toContain("### Session-level usage");
    expect(formatted).not.toContain("USD (credits)");
    expect(formatted).not.toContain("Supported benchmark skills");
    expect(formatted).not.toContain("Unsupported observed skills");
    expect(formatted).toContain("| Input tokens | 12 |");
    expect(formatted).toContain("### By model");
  });

  it("returns JSON, text, and structured errors from historyCommand.run", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-missing-history-command-home";
    try {
      const json = await historyCommand.run(["analyze", "--json"], { cwd: "/repo", json: true });
      expect(json).toMatchObject({
        ok: true,
        output: { schemaVersion: 1, filters: { window: "30d", project: "all" } },
      });
      const text = await historyCommand.run(["analyze"], { cwd: "/repo", json: false });
      expect(text).toMatchObject({ ok: true });
      expect((text as { message: string }).message).toContain("Skill history — simple (30d, project=all)");
      expect(await historyCommand.run(["nope"], { cwd: "/repo", json: false })).toEqual({
        ok: false,
        exitCode: 1,
        message: "history supports only: analyze",
      });
      expect(await historyCommand.run(["nope"], { cwd: "/repo", json: true })).toEqual({
        ok: false,
        exitCode: 1,
        message: "history supports only: analyze",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("writes HTML via --html and reports the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-history-html-cmd-"));
    tempDirs.push(dir);
    const out = join(dir, "retro.html");
    const previousHome = process.env.HOME;
    process.env.HOME = join(dir, "home-missing");
    try {
      const result = await historyCommand.run(["analyze", "7d", "--html", out], {
        cwd: dir,
        json: false,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("HTML report written:");
      expect(result.message).toContain(out);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("<!DOCTYPE html>");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
