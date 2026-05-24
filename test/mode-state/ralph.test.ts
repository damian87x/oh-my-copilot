import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRalphContext, cancelRalph, readRalph, startRalph, tickRalph } from "../../src/mode-state/ralph.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-ralph-"));

describe("ralph mode-state", () => {
  it("startRalph writes the state file at .omp/state/ralph.json", () => {
    const root = cwd();
    const state = startRalph({ cwd: root, prompt: "fix auth", maxIterations: 4 });
    expect(state.active).toBe(true);
    expect(state.iteration).toBe(0);
    expect(existsSync(path.join(root, ".omp", "state", "ralph.json"))).toBe(true);
    const reloaded = readRalph(root);
    expect(reloaded?.prompt).toBe("fix auth");
  });

  it("tickRalph increments iteration and stops at max", () => {
    const root = cwd();
    startRalph({ cwd: root, prompt: "loop", maxIterations: 2 });
    expect(tickRalph(root).state?.iteration).toBe(1);
    expect(tickRalph(root).state?.iteration).toBe(2);
    const third = tickRalph(root);
    expect(third.ok).toBe(false);
    expect(third.reason).toContain("max iterations");
    expect(readRalph(root)).toBeUndefined();
  });

  it("cancelRalph clears the state", () => {
    const root = cwd();
    startRalph({ cwd: root, prompt: "x" });
    cancelRalph(root);
    expect(readRalph(root)).toBeUndefined();
  });

  it("buildRalphContext mentions iteration + prompt", () => {
    const text = buildRalphContext({
      active: true,
      iteration: 3,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: "implement X",
      projectPath: "/tmp/x",
    });
    expect(text).toContain("3/10");
    expect(text).toContain("implement X");
  });
});
