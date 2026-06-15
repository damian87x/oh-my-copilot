import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("skill lifecycle documentation", () => {
  it("documents ralph and ultraqa mode-state commands that exist in CLI help", () => {
    const help = read("src/cli.ts");
    const ralph = read(".github/skills/ralph/SKILL.md");
    const ultraqa = read(".github/skills/ultraqa/SKILL.md");

    for (const command of ["ralph start", "ralph tick", "ralph cancel", "ultraqa start", "ultraqa cycle", "ultraqa cancel"]) {
      expect(help).toContain(command);
    }
    expect(ralph).toContain('omp ralph start "<task>" --max-iterations 10');
    expect(ralph).toContain("omp ralph tick");
    expect(ralph).toContain("omp ralph cancel");
    expect(ultraqa).toContain('omp ultraqa start "<goal>" --max-cycles 5');
    expect(ultraqa).toContain("omp ultraqa cycle fail");
    expect(ultraqa).toContain("omp ultraqa cancel");
  });

  it("keeps daily-log skill, session-start breadcrumb, and memory hint aligned on --days 7", () => {
    expect(read(".github/skills/daily-log/SKILL.md")).toContain("omp daily-log read --days 7");
    expect(read("scripts/session-start.mjs")).toContain("omp daily-log read --days 7");
    expect(read("src/instructions-memory.ts")).toContain("omp daily-log read --days 7");
  });

  it("keeps Jira skill guidance limited to render/dry-run until live write args exist", () => {
    const jira = read(".github/skills/jira-ticket/SKILL.md");
    expect(jira).toContain("omp jira render <plan-file>");
    expect(jira).toContain("dry-run");
    expect(jira).not.toContain("omp jira apply <ticket-key> --comment");
    expect(jira).not.toContain("omp jira apply <ticket-key> --update");
  });

  it("keeps meta research/create-skill docs aligned with team-worker wording", () => {
    expect(read(".github/skills/create-skill/SKILL.md")).toContain("under 200 lines");
    expect(read(".github/skills/research-codebase/reference/agent-prompts.md")).toContain("Worker Prompt Templates");
    expect(read(".github/skills/research-codebase/reference/agent-prompts.md")).toContain("omp team");
  });
});
