import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRepoGoal, writeRepoGoal } from "../src/goal.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-goal-"));

describe("repo goal (src/goal)", () => {
  it("reads empty when no goal is set", () => {
    expect(readRepoGoal(cwd())).toBe("");
  });

  it("writes and reads back the objective, with our header on disk", () => {
    const root = cwd();
    expect(writeRepoGoal(root, "Be the best")).toBe("Be the best");
    expect(readRepoGoal(root)).toBe("Be the best");
    expect(readFileSync(path.join(root, ".omp", "goal.md"), "utf8")).toBe("# Repo Goal\n\nBe the best\n");
  });

  it("collapses multiline input to a single north-star line", () => {
    const root = cwd();
    writeRepoGoal(root, "ship\nthe\nthing");
    expect(readRepoGoal(root)).toBe("ship the thing");
  });

  it("preserves a hand-authored goal that has no Repo Goal header", () => {
    const root = cwd();
    mkdirSync(path.join(root, ".omp"), { recursive: true });
    writeFileSync(path.join(root, ".omp", "goal.md"), "# Ship v1\n", "utf8");
    expect(readRepoGoal(root)).toBe("# Ship v1");
  });
});
