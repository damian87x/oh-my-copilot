import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildUltraworkContext, cancelUltrawork, readUltrawork, startUltrawork } from "../../src/mode-state/ultrawork.js";

const cwd = () => {
  const root = mkdtempSync(path.join(tmpdir(), "omc-uw-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
};

describe("ultrawork mode-state", () => {
  it("starts + reads + cancels", () => {
    const root = cwd();
    const state = startUltrawork({ cwd: root, objective: "process all tickets", taskCount: 7 });
    expect(state.active).toBe(true);
    expect(state.taskCount).toBe(7);
    expect(readUltrawork(root)?.objective).toBe("process all tickets");
    cancelUltrawork(root);
    expect(readUltrawork(root)).toBeUndefined();
  });

  it("buildUltraworkContext lists objective + task count", () => {
    const text = buildUltraworkContext({
      active: true,
      objective: "X",
      startedAt: new Date().toISOString(),
      projectPath: "/tmp/x",
      taskCount: 3,
    });
    expect(text).toContain("Objective: X");
    expect(text).toContain("Tasks: 3");
  });
});
