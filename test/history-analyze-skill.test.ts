import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("history-analyze bundled skill", () => {
  it("delegates to the privacy preserving deterministic CLI", () => {
    const skill = readFileSync(".github/skills/history-analyze/SKILL.md", "utf8");
    const normalizedCommand = "omp history analyze --window WINDOW --project SCOPE --json";

    expect(skill).toContain("name: history-analyze");
    expect(skill).toContain("omp history analyze");
    expect(skill).toMatch(/7d.*30d.*90d.*all/s);
    expect(skill).toMatch(/current.*all/s);
    expect(skill).toContain("actual `skill` tool execution-start events");
    expect(skill).toContain("never read conversation content");
    expect(skill).toContain("session-level-only");
    expect(skill).toContain("preserve every warning");
    expect(skill).toContain(normalizedCommand);
    expect(skill.match(/omp history analyze/g)).toHaveLength(1);
    expect(skill).toMatch(/defaults `30d` and `all`/);
    expect(skill).toContain("exactly one normalized command");
    expect(skill).toContain("Never run the shorthand command after normalization");
    expect(skill).toContain("metricSessions");
    expect(skill).toContain("Do not round, abbreviate, rescale, or recalculate numeric values");
    expect(skill).toContain("Do not print or paste raw JSON");
    expect(skill).toContain("decision first");
    expect(skill).toContain("at most 12 compact bullets or lines");
    expect(skill).toContain("at most 2000 characters");
    expect(skill).toContain("Omit lower-value detail rather than exceeding either bound");
    expect(skill).toContain("small bounded sample");
    expect(skill).toMatch(/warnings[\s\S]*only when necessary[\s\S]*verbatim/i);
    expect(skill).toContain("top-level `skills` array");
    const grillMeToolLoadIndex = skill.indexOf('Call the `skill` tool with `skill: "grill-me"`');
    const normalizedCommandIndex = skill.indexOf(normalizedCommand);
    const decisionFirstIndex = skill.indexOf("decision first");
    const affirmativeAnswerIndex = skill.indexOf("Only after an unambiguous affirmative answer");
    const skillBenchToolLoadIndex = skill.indexOf(
      'call the `skill` tool with `skill: "skill-bench"`',
    );

    expect(grillMeToolLoadIndex).toBeGreaterThanOrEqual(0);
    expect(decisionFirstIndex).toBeGreaterThan(normalizedCommandIndex);
    expect(grillMeToolLoadIndex).toBeGreaterThan(decisionFirstIndex);
    expect(affirmativeAnswerIndex).toBeGreaterThan(grillMeToolLoadIndex);
    expect(skillBenchToolLoadIndex).toBeGreaterThan(affirmativeAnswerIndex);
    expect(skill).toContain("direct mode for the selected skill");
    expect(skill).toContain("Do not start any `python3 run.py --task` command before");
    expect(skill).toContain("On refusal, ambiguity, analyzer failure, no supported skill, or unavailable handoff");
    expect(skill).not.toContain("Return only the requested history report");
  });
});
