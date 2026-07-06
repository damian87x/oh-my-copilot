import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { suggestWorkflow } from "../src/commands/suggest.js";

interface RoutingCase {
  id: string;
  kind: "direct" | "paraphrase" | "ambiguous";
  expected: string;
  prompt: string;
}

const datasetPath = fileURLToPath(
  new URL("../benchmarks/skill-bench/routing/dataset.json", import.meta.url),
);
const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as { cases: RoutingCase[] };

// Skills reachable through at least one RULES workflow in src/commands/suggest.ts.
// Keep in sync when rules change; the coverage test below reports drift.
const REACHABLE = new Set([
  "debug",
  "ralplan",
  "ralph",
  "verify",
  "team",
  "code-review",
  "ultrawork",
  "jira-ticket",
  "ultraqa",
  "tdd",
  "research-codebase",
  "grill-me",
]);

// Ratchet thresholds — measured baseline on 2026-07-05 was 52.8% / 25.0%.
// Raise these when suggest rules improve; never lower them.
const MIN_IN_WORKFLOW_ACCURACY = 0.52;
const MIN_TOP1_ACCURACY = 0.25;

describe("routing benchmark: omp suggest vs labeled dataset", () => {
  const scoreable = dataset.cases.filter(
    (c) => c.expected !== "none" && REACHABLE.has(c.expected),
  );

  it("has scoreable cases", () => {
    expect(scoreable.length).toBeGreaterThan(0);
  });

  it(`expected skill appears in suggested workflow (ratchet ≥ ${MIN_IN_WORKFLOW_ACCURACY})`, () => {
    const misses: string[] = [];
    let hits = 0;
    for (const c of scoreable) {
      const suggestion = suggestWorkflow(c.prompt);
      if (!suggestion.ok) throw new Error(`suggest failed for ${c.id}`);
      if (suggestion.workflow.includes(`/${c.expected}`)) hits++;
      else misses.push(`${c.id} (${c.kind}): expected /${c.expected}, got ${suggestion.workflow.join(" → ")}`);
    }
    const accuracy = hits / scoreable.length;
    expect(accuracy, `misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(MIN_IN_WORKFLOW_ACCURACY);
  });

  it(`expected skill is the first workflow step (ratchet ≥ ${MIN_TOP1_ACCURACY})`, () => {
    let hits = 0;
    for (const c of scoreable) {
      const suggestion = suggestWorkflow(c.prompt);
      if (suggestion.ok && suggestion.workflow[0] === `/${c.expected}`) hits++;
    }
    expect(hits / scoreable.length).toBeGreaterThanOrEqual(MIN_TOP1_ACCURACY);
  });

  it("reports skills unreachable by any suggest rule (coverage gap, informational)", () => {
    const expectedSkills = new Set(
      dataset.cases.map((c) => c.expected).filter((e) => e !== "none"),
    );
    const uncovered = [...expectedSkills].filter((s) => !REACHABLE.has(s)).sort();
    // 15 of 27 skills had no suggest rule when this benchmark was created.
    // Shrink this list by adding rules; never let it grow.
    expect(uncovered.length).toBeLessThanOrEqual(15);
  });
});
