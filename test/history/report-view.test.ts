import { describe, expect, it } from "vitest";
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
