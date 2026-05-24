import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendTraceEntry, traceTools } from "../../../src/mcp/tools/trace.js";

const byName = (name: string) => traceTools.find((t) => t.name === name)!;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-trace-"));

describe("trace tools", () => {
  it("trace_timeline returns appended entries (most recent slice)", async () => {
    const root = cwd();
    for (let i = 0; i < 5; i++) appendTraceEntry(root, "sess1", { event: "tick", payload: { i } });
    const timeline = await byName("trace_timeline").handler({ sessionId: "sess1", limit: 3, cwd: root });
    const parsed = JSON.parse(timeline.content[0]!.text);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[parsed.entries.length - 1].payload.i).toBe(4);
  });

  it("trace_summary counts by event", async () => {
    const root = cwd();
    appendTraceEntry(root, "sess1", { event: "a" });
    appendTraceEntry(root, "sess1", { event: "a" });
    appendTraceEntry(root, "sess1", { event: "b" });
    const summary = await byName("trace_summary").handler({ sessionId: "sess1", cwd: root });
    const parsed = JSON.parse(summary.content[0]!.text);
    expect(parsed.counts).toEqual({ a: 2, b: 1 });
    expect(parsed.total).toBe(3);
  });

  it("returns empty when no traces exist", async () => {
    const root = cwd();
    const timeline = await byName("trace_timeline").handler({ cwd: root });
    expect(JSON.parse(timeline.content[0]!.text)).toEqual({ entries: [] });
  });
});
