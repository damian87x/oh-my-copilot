import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProjectGoal, writeProjectGoal } from "../src/project-goal.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-project-goal-"));

describe("project goal (src/project-goal)", () => {
  it("reads empty when no goal is set", () => {
    expect(readProjectGoal(cwd())).toBe("");
  });

  it("writes and reads back the objective, with our header on disk", () => {
    const root = cwd();
    expect(writeProjectGoal(root, "Be the best")).toBe("Be the best");
    expect(readProjectGoal(root)).toBe("Be the best");
    expect(readFileSync(path.join(root, ".omp", "goal.md"), "utf8")).toBe("# Repo Goal\n\nBe the best\n");
  });

  it("collapses multiline input to a single north-star line", () => {
    const root = cwd();
    writeProjectGoal(root, "ship\nthe\nthing");
    expect(readProjectGoal(root)).toBe("ship the thing");
  });

  it("preserves a hand-authored goal that has no Repo Goal header", () => {
    const root = cwd();
    mkdirSync(path.join(root, ".omp"), { recursive: true });
    writeFileSync(path.join(root, ".omp", "goal.md"), "# Ship v1\n", "utf8");
    expect(readProjectGoal(root)).toBe("# Ship v1");
  });
});
