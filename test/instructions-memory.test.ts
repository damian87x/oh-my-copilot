import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncInstructionsMemory } from "../src/instructions-memory.js";
import { writeRepoGoal } from "../src/goal.js";
import { addDirective } from "../src/project-memory.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-instr-"));
const instr = (root: string) => readFileSync(path.join(root, ".github", "copilot-instructions.md"), "utf8");

describe("instructions memory block", () => {
  it("renders goal + directives into copilot-instructions.md", () => {
    const root = cwd();
    writeRepoGoal(root, "Ship it");
    addDirective(root, "always run tests");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    expect(text).toContain("omp:memory:start");
    expect(text).toContain("**Repo goal:** Ship it");
    expect(text).toContain("- always run tests");
    expect(text).toContain("omp:memory:end");
  });

  it("replaces the block on re-sync without duplicating", () => {
    const root = cwd();
    writeRepoGoal(root, "v1");
    syncInstructionsMemory(root);
    writeRepoGoal(root, "v2");
    syncInstructionsMemory(root);
    const text = instr(root);
    expect(text).toContain("**Repo goal:** v2");
    expect(text).not.toContain("v1");
    expect(text.match(/omp:memory:start/g)?.length).toBe(1);
  });

  it("preserves instructions content outside the managed block", () => {
    const root = cwd();
    mkdirSync(path.join(root, ".github"), { recursive: true });
    writeFileSync(path.join(root, ".github", "copilot-instructions.md"), "# My project\n\nDo good work.\n");
    writeRepoGoal(root, "Ship");
    syncInstructionsMemory(root);
    const text = instr(root);
    expect(text).toContain("Do good work.");
    expect(text).toContain("**Repo goal:** Ship");
  });
});
