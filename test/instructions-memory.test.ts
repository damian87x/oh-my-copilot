import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncInstructionsMemory } from "../src/instructions-memory.js";
import { writeRepoGoal } from "../src/goal.js";
import { setMemoryConfigValue } from "../src/memory-review/config.js";
import { addDirective, addNote } from "../src/project-memory.js";

const originalHomeOverride = process.env.OMP_HOME_OVERRIDE;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-instr-"));
const instr = (root: string) => readFileSync(path.join(root, ".github", "copilot-instructions.md"), "utf8");

describe("instructions memory block", () => {
  afterEach(() => {
    delete process.env.OMP_DISABLE_INSTRUCTIONS_MEMORY;
    if (originalHomeOverride === undefined) {
      delete process.env.OMP_HOME_OVERRIDE;
    } else {
      process.env.OMP_HOME_OVERRIDE = originalHomeOverride;
    }
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

  it("lists note titles (not just a count) so memory is discoverable next session", () => {
    const root = cwd();
    addNote(root, "Auth lives in src/auth", "details");
    addNote(root, "DB schema notes", "details");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    expect(text).toContain("Auth lives in src/auth");
    expect(text).toContain("DB schema notes");
    // bodies stay on-demand (progressive disclosure)
    expect(text).not.toContain("details");
  });

  it("surfaces topic list with id and one-liner description when topics exist", () => {
    const root = cwd();
    addNote(root, "Authentication strategy", "implementation details");
    addNote(root, "Database schema design", "full schema");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    // Topics section should appear with descriptions
    expect(text).toContain("Project topics");
    expect(text).toContain("Authentication strategy");
    expect(text).toContain("Database schema design");
    // Only ids shown, not full bodies
    expect(text).not.toContain("implementation details");
    expect(text).not.toContain("full schema");
  });

  it("truncates topic descriptions to keep them brief", () => {
    const root = cwd();
    const longDesc = "This is a very long description that should be truncated to keep the instructions block from getting too large and bloated over time";
    addNote(root, longDesc, "body content");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    // Check that topic description is truncated
    expect(text).toContain("Project topics");
    // The truncated version should appear in the topics section (truncated to 57 chars + …)
    expect(text).toContain("This is a very long description that should be truncated …");
    // Verify descriptions are kept brief - check in topics section only
    const topicsStart = text.indexOf("Project topics");
    const topicsEnd = text.indexOf("<!-- omp:memory:end -->");
    const topicsSection = text.substring(topicsStart, topicsEnd);
    // The long body "body content" should not appear in topics
    expect(topicsSection).not.toContain("body content");
  });

  it("caps topic list using the configured ~/.omp topic title limit and shows overflow pointer", () => {
    const root = cwd();
    const home = cwd();
    process.env.OMP_HOME_OVERRIDE = home;
    setMemoryConfigValue(root, "instructionsMemoryTopicTitles", "2", { scope: "global", homeDir: home });
    for (const title of ["Alpha topic", "Beta topic", "Gamma topic", "Delta topic"]) {
      addNote(root, title, "body");
    }
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    const topicsSection = text.substring(text.indexOf("Project topics"));
    expect(topicsSection).toContain("Alpha topic");
    expect(topicsSection).toContain("Beta topic");
    expect(topicsSection).not.toContain("Delta topic");
    expect(topicsSection).not.toContain("Gamma topic");
    expect(topicsSection).toContain("(+2 more — `omp project-memory topics` for full list)");
    expect(topicsSection).not.toContain("body");
  });

  it("never injects full fact bodies in rendered block", () => {
    const root = cwd();
    addNote(root, "Config structure", "This is sensitive config documentation that should not be inlined");
    expect(syncInstructionsMemory(root).wrote).toBe(true);
    const text = instr(root);
    expect(text).toContain("Config structure");
    expect(text).not.toContain("sensitive config documentation");
    expect(text).not.toContain("should not be inlined");
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
