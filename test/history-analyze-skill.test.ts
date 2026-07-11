import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("history-analyze bundled skill", () => {
  it("delegates to the privacy preserving deterministic CLI", () => {
    const skill = readFileSync(".github/skills/history-analyze/SKILL.md", "utf8");
    expect(skill).toContain("name: history-analyze");
    expect(skill).toContain("omp history analyze");
    expect(skill).toMatch(/7d.*30d.*90d.*all/s);
    expect(skill).toMatch(/current.*all/s);
    expect(skill).toContain("actual `skill` tool execution-start events");
    expect(skill).toContain("never read conversation content");
    expect(skill).toContain("session-level-only");
    expect(skill).toContain("preserve every warning");
    expect(skill).toContain("omp history analyze --json");
    expect(skill).toContain("metricSessions");
    expect(skill).toContain("Do not round, abbreviate, rescale, or recalculate numeric values");
    expect(skill).toContain("Return only the requested history report");
  });
});
