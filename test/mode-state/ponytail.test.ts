import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPonytailContext,
  cancelPonytail,
  normalizeLevel,
  readPonytail,
  startPonytail,
} from "../../src/mode-state/ponytail.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-pt-"));

describe("ponytail mode-state", () => {
  it("starts + reads + cancels", () => {
    const root = cwd();
    const state = startPonytail(root, "ultra");
    expect(state.active).toBe(true);
    expect(state.level).toBe("ultra");
    expect(readPonytail(root)?.level).toBe("ultra");
    cancelPonytail(root);
    expect(readPonytail(root)).toBeUndefined();
  });

  it("defaults to full and rejects unknown levels", () => {
    expect(normalizeLevel(undefined)).toBe("full");
    expect(normalizeLevel("nonsense")).toBe("full");
    expect(normalizeLevel("LITE")).toBe("lite");
  });

  it("buildPonytailContext carries the ladder and the never-lazy guard", () => {
    const text = buildPonytailContext({
      active: true,
      level: "full",
      startedAt: new Date().toISOString(),
      projectPath: "/tmp/x",
    });
    expect(text).toContain("PONYTAIL ACTIVE: full");
    expect(text).toContain("YAGNI");
    expect(text).toContain("security");
  });
});
