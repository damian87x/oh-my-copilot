import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRepoGoal } from "../src/goal.js";
import { syncInstructionsMemory } from "../src/instructions-memory.js";
import { runSetup } from "../src/copilot/setup.js";

const root = () => process.cwd();
const readRepoFile = (relativePath: string) => readFileSync(path.join(root(), relativePath), "utf8");

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}');
  return dir;
}

function tempPlugin(): string {
  const dir = tempRoot("omc-cost-plugin-");
  mkdirSync(path.join(dir, ".github", "skills"), { recursive: true });
  mkdirSync(path.join(dir, ".github", "agents"), { recursive: true });
  return dir;
}

describe("cost/token instruction contracts", () => {
  it("keeps setup template and committed Copilot instructions aligned on cost semantics", () => {
    const project = tempRoot("omc-cost-project-");
    runSetup({ cwd: project, pluginRoot: tempPlugin() });

    const generated = readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8");
    const committed = readRepoFile(".github/copilot-instructions.md");
    const requiredPhrases = [
      "## Cost/token discipline",
      "`omp cost [--today] [--session <id>]`",
      "not provider billing",
      "session-wide visibility for skills invoked inside that session",
      "Oversized postToolUse output is",
      "not current live behavior",
    ];

    for (const phrase of requiredPhrases) {
      expect(generated).toContain(phrase);
      expect(committed).toContain(phrase);
    }
  });

  it("preserves static cost guidance outside the managed memory block", () => {
    const project = tempRoot("omc-cost-memory-");
    mkdirSync(path.join(project, ".github"), { recursive: true });
    writeFileSync(
      path.join(project, ".github", "copilot-instructions.md"),
      [
        "# Project",
        "",
        "## Cost/token discipline",
        "Use `omp cost` for local hook-ledger estimates only; it is not provider billing.",
        "",
        "<!-- omp:memory:start -->",
        "old managed content",
        "<!-- omp:memory:end -->",
        "",
      ].join("\n"),
    );
    writeRepoGoal(project, "Ship docs guard");

    expect(syncInstructionsMemory(project).wrote).toBe(true);

    const text = readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8");
    expect(text).toContain("## Cost/token discipline");
    expect(text).toContain("not provider billing");
    expect(text).toContain("**Repo goal:** Ship docs guard");
    expect(text).not.toContain("old managed content");
  });

  it("documents cost visibility globally and only adds concise reminders to selected high-cost skills", () => {
    const selected = new Set([
      "omp-autopilot",
      "research-codebase",
      "schedule",
      "team",
      "ultrawork",
      "weighted-consensus",
    ]);
    const skillRoot = path.join(root(), ".github", "skills");

    for (const name of selected) {
      const body = readFileSync(path.join(skillRoot, name, "SKILL.md"), "utf8");
      expect(body, `${name} cost note`).toContain("## Cost/token note");
      expect(body, `${name} mentions omp cost`).toContain("omp cost");
      expect(body, `${name} avoids billing claim`).toMatch(/not (provider )?billing/i);
    }

    const allSkills = readdirSync(skillRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(allSkills).toContain("schedule");
    expect(allSkills.filter((name) => selected.has(name)).sort()).toEqual([...selected].sort());
    expect(readRepoFile("docs/general-skills.md")).toContain("Do not duplicate global cost/token boilerplate");
  });

  it("documents camelCase hooks, the cost command, and live output minimization", () => {
    const readme = readRepoFile("README.md");
    const hookLine = readme.split("\n").find((line) => line.includes("Lifecycle hooks")) ?? "";

    expect(hookLine).toContain("sessionStart");
    expect(hookLine).toContain("userPromptSubmitted");
    expect(hookLine).toContain("preToolUse");
    expect(hookLine).toContain("postToolUse");
    expect(hookLine).toContain("postToolUseFailure");
    expect(hookLine).toContain("errorOccurred");
    expect(hookLine).not.toContain("SessionStart");
    expect(readme).toContain("omp cost [--today] [--session <id>]");
    expect(readme).toContain("best-effort estimates, not provider billing");
    expect(readme).toContain("oversized `postToolUse` output is minimized");
    expect(readme).toContain("Budget gates and retry-cost guidance remain next-step optimization work");
  });

  it("does not place static cost guidance inside the managed memory marker region", () => {
    const instructions = readRepoFile(".github/copilot-instructions.md");
    const start = instructions.indexOf("<!-- omp:memory:start -->");

    expect(instructions).toContain("## Cost/token discipline");
    if (start >= 0) {
      const end = instructions.indexOf("<!-- omp:memory:end -->");
      expect(end).toBeGreaterThan(start);
      const managed = instructions.slice(start, end);
      expect(managed).not.toContain("## Cost/token discipline");
      expect(instructions.indexOf("## Cost/token discipline")).toBeLessThan(start);
    }
  });
});
