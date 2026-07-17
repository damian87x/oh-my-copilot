import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("history-analyze bundled skill", () => {
  it("delegates to the privacy preserving deterministic CLI and generic skill-bench handoff", () => {
    const skill = readFileSync(".github/skills/history-analyze/SKILL.md", "utf8");
    const normalizedCommand = "omp history analyze --window WINDOW --project SCOPE --json";
    const bannedFixedContracts = [
      "benchmarkable",
      "benchmarkTask",
      "code-review-sqli",
      "tdd-slugify",
      "ralplan-pwreset",
      "debug-inflight-dedup",
      "python3 run.py",
      "grill-me",
    ];
    const expectInOrder = (...markers: string[]) => {
      let previousIndex = -1;

      for (const marker of markers) {
        const index = skill.indexOf(marker, previousIndex + 1);
        expect(index, `expected ${marker} after the previous contract marker`).toBeGreaterThan(
          previousIndex,
        );
        previousIndex = index;
      }
    };

    expect(skill).toContain("name: history-analyze");
    expect(skill).toContain(normalizedCommand);
    expect(skill.match(/omp history analyze/g)).toHaveLength(1);
    expect(skill).toMatch(/7d.*30d.*90d.*all/s);
    expect(skill).toMatch(/current.*all/s);
    expect(skill).toContain("actual `skill` tool execution-start events");
    expect(skill).toContain("never read conversation content");
    expect(skill).toContain("session-level-only");
    expect(skill).toContain("preserve every warning");
    expect(skill).toContain("metricSessions");
    expect(skill).toContain("Do not round, abbreviate, rescale, or recalculate numeric values");
    expect(skill).toContain("Do not print or paste raw JSON");
    expect(skill).toContain("decision first");
    expect(skill).toContain("at most 12 compact bullets or lines");
    expect(skill).toContain("at most 2000 characters");
    expect(skill).toContain("top-level `skills` array");
    expect(skill).toContain("arbitrary observed skills");
    expect(skill).toMatch(/metadata-only history/i);
    expect(skill).toMatch(/must not claim semantic task or failure content/i);
    expect(skill).toMatch(/schema-version-1 report[\s\S]*before presentation/i);
    expectInOrder(
      normalizedCommand,
      "decision first",
      "Offer `/skill-bench SELECTED_SKILL`",
      "Offer `/skill-bench WINDOW SCOPE`",
    );
    expect(skill).toMatch(/selected arbitrary skill/i);
    expect(skill).toContain("without starting a live run");
    expect(skill).toMatch(/silence,\s+empty answer,\s+non-answer,\s+refusal,\s+ambiguity/i);
    for (const banned of bannedFixedContracts) {
      expect(skill).not.toContain(banned);
    }
  });
});
