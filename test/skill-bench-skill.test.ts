import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const skillPath = path.join(root, ".github", "skills", "skill-bench", "SKILL.md");

describe("bundled skill-bench skill", () => {
  it("exposes friendly modes backed by the packaged benchmark", () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf8");

    expect(skill).toContain("name: skill-bench");
    expect(skill).toContain("Use with bare /skill-bench");
    expect(skill).toContain("top-level `skills` array");
    expect(skill).toContain("top-level `unsupportedSkills` array");
    expect(skill).toContain("`skill`, `invocations`, `sessions`, `lastInvokedAt`, `benchmarkable`, and `benchmarkTask`");
    expect(skill).toContain("never suggest arbitrary project names");
    expect(skill).toContain("omp version --json");
    expect(skill).toMatch(/code-review[\s\S]*code-review-sqli/);
    expect(skill).toMatch(/tdd[\s\S]*tdd-slugify/);
    expect(skill).toMatch(/ralplan[\s\S]*ralplan-pwreset/);
    expect(skill).toContain("check");
    expect(skill).toContain("latest");
    expect(skill).toContain("--selftest");
    expect(skill).toContain("`/skill-bench code-review`");
    expect(skill).toContain("`/skill-bench code-review --models default`");
    expect(skill).toContain("`/skill-bench code-review --models gpt-5.6-luna`");
    expect(skill).toContain("host default");
    expect(skill).toContain("History chooses the skill, not the model.");
    expect(skill).toMatch(/skip only unavailable models/i);
    expect(skill).toContain("Do not replace requested models");
    expect(skill).not.toContain("--models gpt-5-mini,claude-haiku-4.5");
    expect(skill).toContain("--runs 1");
    expect(skill).toContain("--workers 2");
    expect(skill).toContain("sweep_report.html");
    const historyIndex = skill.indexOf("omp history analyze --window 30d --project all --json");
    const grillIndex = skill.indexOf("/grill-me");
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(grillIndex).toBeGreaterThan(historyIndex);
    expect(skill).toMatch(/require a\s+successful schema-version-1 history report before invoking `\/grill-me`/);
    expect(skill).toContain('Call the `skill` tool with `skill: "grill-me"`');
    expect(skill).toMatch(/Do not call `ask_user` directly\s+before loading it/);
    expect(skill).toContain("Select the first ranked supported skill");
    expect(skill).toContain("omp history analyze --window <window> --project <project> --json");
    expect(skill).toContain("explicit affirmative confirmation");
    expect(skill).toContain("unsupported skills");
    expect(skill).toContain("stop without starting live benchmark cells");
  });

  it("includes the benchmark engine in npm packages", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      files: string[];
    };

    expect(manifest.files).toContain("benchmarks/skill-bench");
  });

  it("documents the plain setup and lightweight smoke flow", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");

    expect(readme).toContain("omp setup");
    expect(readme).toContain("/skill-bench check");
    expect(readme).toContain("/skill-bench code-review --models default");
    expect(readme).toContain("/skill-bench code-review --models gpt-5.6-luna");
    expect(readme).not.toMatch(/installed-plugins[\s\S]*cp -R/);
  });
});
