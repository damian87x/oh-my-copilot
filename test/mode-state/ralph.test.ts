import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRalphContext, cancelRalph, readRalph, startRalph, tickRalph } from "../../src/mode-state/ralph.js";

const cwd = () => {
  const root = mkdtempSync(path.join(tmpdir(), "omc-ralph-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
};

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

  it("tickRalph records completed slices without advancing the loop counter", () => {
    const root = cwd();
    startRalph({ cwd: root, prompt: "loop", maxIterations: 2 });
    expect(tickRalph(root).state).toMatchObject({ iteration: 0, completedSlices: 1 });
    expect(tickRalph(root).state).toMatchObject({ iteration: 0, completedSlices: 2 });
    expect(readRalph(root)).toMatchObject({ active: true, iteration: 0, completedSlices: 2 });
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
      completedSlices: 2,
      startedAt: new Date().toISOString(),
      prompt: "implement X",
      projectPath: "/tmp/x",
    });
    expect(text).toContain("3/10");
    expect(text).toContain("Completed slices: 2");
    expect(text).toContain("implement X");
  });
});
