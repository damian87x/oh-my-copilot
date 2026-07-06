import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildUltraqaContext,
  cancelUltraqa,
  readUltraqa,
  recordUltraqaCycle,
  startUltraqa,
} from "../../src/mode-state/ultraqa.js";

const cwd = () => {
  const root = mkdtempSync(path.join(tmpdir(), "omc-uq-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
};

describe("ultraqa mode-state", () => {
  it("records a failing verdict without advancing the hook-owned cycle counter", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass", maxCycles: 3 });
    const r = recordUltraqaCycle(root, "fail");
    expect(r.state?.cycleCount).toBe(0);
    expect(r.state?.lastVerdict).toBe("fail");
  });

  it("a passing cycle clears the state", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass" });
    recordUltraqaCycle(root, "pass");
    expect(readUltraqa(root)).toBeUndefined();
  });

  it("does not enforce maxCycles from the cycle command", () => {
    const root = cwd();
    startUltraqa({ cwd: root, goal: "tests pass", maxCycles: 2 });
    recordUltraqaCycle(root, "fail");
    const second = recordUltraqaCycle(root, "fail");
    expect(second.ok).toBe(true);
    expect(second.state).toMatchObject({ active: true, cycleCount: 0, lastVerdict: "fail" });
    expect(readUltraqa(root)).toMatchObject({ active: true, cycleCount: 0 });
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
