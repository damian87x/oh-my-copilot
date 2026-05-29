import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isLoopModeActive, writeModeStateJson, type LoopMode } from "../../src/mode-state/paths.js";

function tempCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "omc-loopmode-"));
}

describe("isLoopModeActive", () => {
  it("returns false when no mode state files exist", () => {
    expect(isLoopModeActive(tempCwd())).toBe(false);
  });

  it.each<LoopMode>(["ralph", "ultrawork", "ultraqa"])("returns true when %s is active", (mode) => {
    const cwd = tempCwd();
    writeModeStateJson(cwd, mode, { active: true });
    expect(isLoopModeActive(cwd)).toBe(true);
  });

  it("returns false when all mode files have active: false", () => {
    const cwd = tempCwd();
    writeModeStateJson(cwd, "ralph", { active: false });
    writeModeStateJson(cwd, "ultrawork", { active: false });
    writeModeStateJson(cwd, "ultraqa", { active: false });
    expect(isLoopModeActive(cwd)).toBe(false);
  });
});
