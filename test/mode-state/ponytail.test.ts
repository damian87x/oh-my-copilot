import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cancelPonytail, normalizeLevel, readPonytail, startPonytail } from "../../src/mode-state/ponytail.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-pt-"));
const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/prompt-submit.mjs");

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

  it("the prompt-submit hook re-injects the ladder + never-lazy guard while active", () => {
    const root = cwd();
    startPonytail(root, "ultra");
    const out = execFileSync("node", [HOOK], {
      input: JSON.stringify({ cwd: root, prompt: "hi", sessionId: "t1" }),
      encoding: "utf8",
    });
    const ctx = JSON.parse(out).additionalContext as string;
    expect(ctx).toContain("PONYTAIL ACTIVE: ultra");
    expect(ctx).toContain("YAGNI");
    expect(ctx).toContain("security");
  });

  it("the hook injects nothing for ponytail once it is off", () => {
    const root = cwd();
    startPonytail(root, "full");
    cancelPonytail(root);
    const out = execFileSync("node", [HOOK], {
      input: JSON.stringify({ cwd: root, prompt: "hi", sessionId: "t2" }),
      encoding: "utf8",
    });
    expect(out).not.toContain("PONYTAIL ACTIVE");
  });
});
