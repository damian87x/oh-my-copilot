import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendTraceEntry, traceSummary, traceTimeline } from "../src/trace.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-trace-"));

describe("trace (src/trace)", () => {
  it("returns empty when there is no trace", () => {
    expect(traceTimeline(cwd()).entries).toEqual([]);
    expect(traceSummary(cwd())).toEqual({ total: 0, counts: {} });
  });

  it("appends and reads a session timeline", () => {
    const root = cwd();
    appendTraceEntry(root, "s1", { event: "start" });
    appendTraceEntry(root, "s1", { event: "edit", payload: { file: "a.ts" } });
    const tl = traceTimeline(root, "s1");
    expect(tl.sessionId).toBe("s1");
    expect(tl.entries.map((e) => e.event)).toEqual(["start", "edit"]);
  });

  it("summarises events as counts", () => {
    const root = cwd();
    appendTraceEntry(root, "s2", { event: "edit" });
    appendTraceEntry(root, "s2", { event: "edit" });
    appendTraceEntry(root, "s2", { event: "test" });
    const sum = traceSummary(root, "s2");
    expect(sum.total).toBe(3);
    expect(sum.counts).toEqual({ edit: 2, test: 1 });
  });

  it("rejects an invalid sessionId", () => {
    expect(() => appendTraceEntry(cwd(), "bad/id", { event: "x" })).toThrow(/invalid sessionId/);
  });
});
