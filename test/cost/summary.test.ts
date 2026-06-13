import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCostRecord } from "../../src/cost/ledger.js";
import { summarizeCost } from "../../src/cost/summary.js";

describe("summarizeCost", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-cost-summary-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("aggregates totals by event, tool, model, and top sinks", () => {
    appendCostRecord(root, { sessionId: "s1", event: "userPromptSubmitted", model: "gpt-5-mini", inTokens: 4 });
    appendCostRecord(root, { sessionId: "s1", event: "postToolUse", toolName: "bash", model: "gpt-5-mini", inTokens: 2, outTokens: 10 });
    appendCostRecord(root, { sessionId: "s2", event: "postToolUse", toolName: "grep", inTokens: 1, outTokens: 3 });

    const summary = summarizeCost(root, { sessionId: "s1" });

    expect(summary.records).toBe(2);
    expect(summary.sessions).toEqual(["s1"]);
    expect(summary.totals).toMatchObject({ inTokens: 6, outTokens: 10, totalTokens: 16 });
    expect(summary.byEvent.postToolUse.totalTokens).toBe(12);
    expect(summary.byTool.bash.totalTokens).toBe(12);
    expect(summary.byModel["gpt-5-mini"].totalTokens).toBe(16);
    expect(summary.topSinks[0]).toMatchObject({ label: "tool:bash", totalTokens: 12 });
  });
});
