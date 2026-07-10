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
    expect(skill).toContain("omp version --json");
    expect(skill).toMatch(/code-review[\s\S]*code-review-sqli/);
    expect(skill).toMatch(/tdd[\s\S]*tdd-slugify/);
    expect(skill).toMatch(/ralplan[\s\S]*ralplan-pwreset/);
    expect(skill).toContain("check");
    expect(skill).toContain("latest");
    expect(skill).toContain("--selftest");
    expect(skill).toContain("--models gpt-5-mini,claude-haiku-4.5");
    expect(skill).toContain("--runs 1");
    expect(skill).toContain("--workers 2");
    expect(skill).toContain("sweep_report.html");
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
    expect(readme).not.toMatch(/installed-plugins[\s\S]*cp -R/);
  });
});
