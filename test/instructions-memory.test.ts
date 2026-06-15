import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncInstructionsMemory } from "../src/instructions-memory.js";
import { writeRepoGoal } from "../src/goal.js";
import { addDirective } from "../src/project-memory.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-instr-"));
const instr = (root: string) => readFileSync(path.join(root, ".github", "copilot-instructions.md"), "utf8");

describe("instructions memory block", () => {
  afterEach(() => {
    delete process.env.OMP_DISABLE_INSTRUCTIONS_MEMORY;
  });

  it("renders a lightweight on-demand project context block", () => {
    const root = cwd();
    writeRepoGoal(root, "Ship it");
    addDirective(root, "always run tests");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    expect(text).toContain("omp:memory:start");
    expect(text).toContain("## oh-my-copilot project context");
    expect(text).toContain("**Repo goal:** Ship it");
    expect(text).toContain("Project memory is available on demand:");
    expect(text).toContain("`omp project-memory read`");
    expect(text).toContain("`omp project-memory read <id>`");
    expect(text).toContain("`omp daily-log read --days 7`");
    expect(text).not.toContain("always run tests");
    expect(text).not.toContain("must follow");
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

  it("fails closed (never clobbers) when a marker is orphaned", () => {
    const root = cwd();
    mkdirSync(path.join(root, ".github"), { recursive: true });
    // orphan START (no END) wrapping user content
    writeFileSync(
      path.join(root, ".github", "copilot-instructions.md"),
      "# Mine\n<!-- omp:memory:start -->\nimportant user notes\n",
    );
    writeRepoGoal(root, "Ship");
    expect(syncInstructionsMemory(root).wrote).toBe(false);
    expect(instr(root)).toContain("important user notes"); // untouched
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

  it("skips writing the managed block when instructions memory is disabled", () => {
    const root = cwd();
    process.env.OMP_DISABLE_INSTRUCTIONS_MEMORY = "1";
    writeRepoGoal(root, "Ship");

    const result = syncInstructionsMemory(root);

    expect(result.wrote).toBe(false);
    expect(existsSync(path.join(root, ".github", "copilot-instructions.md"))).toBe(false);
  });
});
