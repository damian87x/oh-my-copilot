import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs hook helper, no types
import { scanScheduleResults } from "../../scripts/lib/schedule-results.mjs";

let dir: string;
let resultsDir: string;

function writeResult(id: string, summary: string, status = "ok"): void {
  const p = path.join(resultsDir, `${id}.jsonl`);
  appendFileSync(p, `${JSON.stringify({ ts: "2026-06-01T08:00:00Z", exitCode: 0, status, summary, logPath: "", durationMs: 1 })}\n`);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omp-sched-hook-"));
  resultsDir = path.join(dir, ".omp", "state", "schedule", "results");
  mkdirSync(resultsDir, { recursive: true });
});

describe("scanScheduleResults", () => {
  it("returns empty when there are no results", () => {
    expect(scanScheduleResults(dir)).toBe("");
  });

  it("emits a banner for unseen results and advances the cursor (banner once)", () => {
    writeResult("pr", "PR #42 has 2 new comments");
    writeResult("pr", "PR #42 unchanged");
    const banner = scanScheduleResults(dir);
    expect(banner).toContain("[SCHEDULE RESULTS]");
    expect(banner).toContain("PR #42 has 2 new comments");
    expect(banner).toContain("PR #42 unchanged");
    // cursor advanced -> a second scan sees nothing
    expect(scanScheduleResults(dir)).toBe("");
    // and the JSONL was NOT rewritten (still 2 lines)
    const lines = readFileSync(path.join(resultsDir, "pr.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("caps at maxEntries and leaves the rest for the next scan", () => {
    for (let i = 0; i < 15; i++) writeResult("pr", `run ${i}`);
    const first = scanScheduleResults(dir, { maxEntries: 10 });
    expect(first.split("\n").filter((l) => l.startsWith("- ")).length).toBe(10);
    const second = scanScheduleResults(dir, { maxEntries: 10 });
    expect(second.split("\n").filter((l) => l.startsWith("- ")).length).toBe(5);
    expect(scanScheduleResults(dir, { maxEntries: 10 })).toBe("");
  });

  it("bounds the read by maxBytes (does not scan an unbounded file in one pass)", () => {
    for (let i = 0; i < 100; i++) writeResult("pr", `padded summary line number ${i} ----------`);
    // tiny byte budget -> only the first complete line(s) within the window are consumed
    const banner = scanScheduleResults(dir, { maxEntries: 100, maxBytes: 200 });
    const count = banner.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
  });
});
