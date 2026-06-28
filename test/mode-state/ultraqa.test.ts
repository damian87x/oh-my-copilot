import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildUltraqaContext,
  cancelUltraqa,
  readUltraqa,
  recordUltraqaCycle,
  startUltraqa,
} from "../../src/mode-state/ultraqa.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-uq-"));

describe("ultraqa mode-state", () => {
  it("starts and records a failing cycle", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass", maxCycles: 3 });
    const r = recordUltraqaCycle(root, "fail");
    expect(r.state?.cycleCount).toBe(1);
    expect(r.state?.lastVerdict).toBe("fail");
  });

  it("a passing cycle clears the state", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass" });
    recordUltraqaCycle(root, "pass");
    expect(readUltraqa(root)).toBeUndefined();
  });

  it("hits maxCycles and clears", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass", maxCycles: 2 });
    recordUltraqaCycle(root, "fail");
    const second = recordUltraqaCycle(root, "fail");
    expect(second.ok).toBe(false);
    expect(readUltraqa(root)).toBeUndefined();
  });

  it("cancelUltraqa clears state", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "x" });
    cancelUltraqa(root);
    expect(readUltraqa(root)).toBeUndefined();
  });

  it("buildUltraqaContext mentions cycle + verdict", () => {
    const text = buildUltraqaContext({
      active: true,
      goal: "X",
      cycleCount: 2,
      maxCycles: 5,
      startedAt: new Date().toISOString(),
      projectPath: "/tmp/x",
      lastVerdict: "fail",
    });
    expect(text).toContain("cycle 2/5");
    expect(text).toContain("Last verdict: fail");
  });
});
