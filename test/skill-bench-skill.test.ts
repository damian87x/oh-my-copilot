import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const skillPath = path.join(root, ".github", "skills", "skill-bench", "SKILL.md");

describe("bundled skill-bench skill", () => {
  it("is a thin guided/direct entrypoint around omp skill-bench", () => {
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf8");
    const bannedFixedContracts = [
      "benchmarkable",
      "benchmarkTask",
      "code-review-sqli",
      "tdd-slugify",
      "ralplan-pwreset",
      "debug-inflight-dedup",
      "python3",
      "run.py",
      "benchmarks/skill-bench",
      "sweep_report.html",
      "--selftest",
      "/grill-me",
      "gpt-5.6-luna",
      "reference grid",
      "fixed direct supported modes",
    ];

    expect(skill).toContain("name: skill-bench");
    expect(skill).toMatch(/description: Use when .*compare an arbitrary skill or path/i);
    expect(skill).toContain("omp skill-bench");
    expect(skill).toMatch(/bare `\/skill-bench`/i);
    expect(skill).toMatch(/`\/skill-bench SKILL_OR_PATH`/);
    expect(skill).toMatch(/arbitrary skill name, installed skill identity, or filesystem path/i);
    expect(skill).toMatch(/durable, resumable pair-design/i);
    expect(skill).toMatch(/approval/i);
    expect(skill).toMatch(/freeze/i);
    expect(skill).toMatch(/budget/i);
    expect(skill).toMatch(/Do not\s+start live benchmark cells/i);
    expect(skill).toMatch(/approved frozen design/i);
    expect(skill).toMatch(/hard budget/i);
    expect(skill).toMatch(/history\s+can rank\s+candidates/i);
    expect(skill).toMatch(/Copilot CLI session history/i);
    expect(skill).toMatch(/OMP is only\s+the parser and orchestrator/i);
    expect(skill).toMatch(/never describe .* as OMP history/i);
    expect(skill).toMatch(/never restricts/i);
    expect(skill).toMatch(/selected arbitrary skill/i);
    expect(skill).toMatch(/no fixed skill-to-task mapping/i);
    expect(skill).toMatch(/Do not expose Python/i);
    expect(skill).toMatch(/Do not require a package checkout/i);
    expect(skill).toMatch(/Do not depend on another skill/i);
    expect(skill).toMatch(/stop without starting live benchmark cells/i);
    expect(skill).toMatch(/refusal, ambiguity, missing approval, failed history/i);
    expect(skill).toMatch(/run exactly one normalized `omp skill-bench.*--json` command/i);
    expect(skill).toMatch(/do not\s+print or paste raw JSON/i);
    expect(skill).toMatch(/continue in the\s+same skill invocation/i);
    expect(skill).toMatch(/show the ranked candidates/i);
    expect(skill).toMatch(/ask exactly one\s+unresolved high-impact question/i);
    expect(skill).toMatch(/rerun direct mode with\s+the selected identity or path/i);
    expect(skill).toMatch(/show the manifest diff before any gate approval/i);
    expect(skill).toMatch(/model probes can consume provider requests/i);
    expect(skill).toMatch(/probe\s+only the explicit model ids/i);
    expect(skill).toContain("--probe-models");
    expect(skill).toMatch(/unknown remains selectable/i);
    expect(skill).toContain("--approve-spend");
    expect(skill).toMatch(/hash-bound spend approval/i);
    expect(skill).toMatch(/provider total.*otherwise input \+ output/i);
    expect(skill).toMatch(/cache-read tokens are\s+already included in input/i);
    expect(skill).toMatch(/totalNanoAiu.*direct.*USD/i);
    expect(skill).toMatch(/official GitHub Copilot pricing[\s\S]{0,200}pricing\.json/i);
    expect(skill).toMatch(/public-price proxy[\s\S]{0,100}not a[\s\S]{0,100}GitHub Copilot invoice/i);
    expect(skill).toMatch(/report.*backfill.*without.*model call/i);
    expect(skill).toMatch(/synthetic execution only for explicit synthetic\/dry-run smoke requests/i);
    expect(skill).toMatch(/freeze earlier if a non-synthetic reviewed manifest is missing the approved Copilot provider/i);
    expect(skill).toMatch(/provider \{kind:"copilot", approved:true\}/i);
    expect(skill).toMatch(/execution\.allowlistedTools/i);
    expect(skill).toMatch(/non-empty execution\.allowlistedTools/i);
    expect(skill).toMatch(/maxUsd/i);
    expect(skill).toMatch(/maxCells/i);
    expect(skill).toMatch(/maxRuntimeMs/i);
    expect(skill).toMatch(/maxPremiumRequests/i);
    expect(skill).toMatch(/budgets\.estimatedCellUsd/i);
    expect(skill).toMatch(/budgets\.estimatedCellPremiumRequests/i);
    expect(skill).toMatch(/preview the export without `--approve`/i);
    expect(skill).toMatch(/repeat with `--approve` only after the user approves/i);
    expect(skill).toMatch(/run `omp skill-bench apply .* --dry-run` first/i);
    expect(skill).not.toContain("unsupportedSkills");
    for (const banned of bannedFixedContracts) {
      expect(skill).not.toContain(banned);
    }
  });
});
