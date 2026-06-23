import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gettingStartedHint,
  maybePromptUpdate,
  maybeWelcome,
} from "../../src/copilot/update-prompt.js";

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-update-prompt-"));
  // Give ompRoot() a deterministic anchor.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tmp", version: "0.0.1" }));
  return root;
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

function newProject(): string {
  const root = tempProject();
  cleanups.push(root);
  return root;
}

/** IO double that records prints and replays scripted answers. */
function fakeIO(answers: Array<string | undefined> = []) {
  const prints: string[] = [];
  const asked: string[] = [];
  return {
    prints,
    asked,
    io: {
      print: (line: string) => prints.push(line),
      ask: async (prompt: string) => {
        asked.push(prompt);
        return answers.shift();
      },
    },
  };
}

const update = { current: "0.0.1", latest: "9.9.9" };
const baseOpts = {
  checkForUpdate: async () => update,
  formatUpdateNotice: (c: string, l: string) => `notice ${c}->${l}`,
};

describe("maybePromptUpdate", () => {
  it("runs the update when the user confirms", async () => {
    const { io, prints, asked } = fakeIO(["y"]);
    let ran = 0;
    const outcome = await maybePromptUpdate({
      cwd: newProject(),
      io,
      interactive: true,
      ...baseOpts,
      runUpdate: async () => {
        ran += 1;
        return true;
      },
    });
    expect(ran).toBe(1);
    expect(asked).toHaveLength(1);
    expect(prints.some((p) => p.includes("Updated to v9.9.9"))).toBe(true);
    expect(outcome.updated).toBe(true);
  });

  it("declines without updating and shows the getting-started hint", async () => {
    const { io, prints } = fakeIO(["n"]);
    let ran = 0;
    const outcome = await maybePromptUpdate({
      cwd: newProject(),
      io,
      interactive: true,
      ...baseOpts,
      runUpdate: async () => {
        ran += 1;
        return true;
      },
    });
    expect(ran).toBe(0);
    expect(prints).toContain(gettingStartedHint());
    expect(outcome.updated).toBe(false);
  });

  it("falls back to the manual command when the update fails", async () => {
    const { io, prints } = fakeIO(["yes"]);
    const outcome = await maybePromptUpdate({
      cwd: newProject(),
      io,
      interactive: true,
      ...baseOpts,
      runUpdate: async () => false,
    });
    expect(prints.some((p) => p.includes("Update failed"))).toBe(true);
    expect(outcome.updated).toBe(false);
  });

  it("never prompts when non-interactive — passive notice only", async () => {
    const { io, prints, asked } = fakeIO();
    await maybePromptUpdate({ cwd: newProject(), io, interactive: false, ...baseOpts });
    expect(asked).toHaveLength(0);
    expect(prints).toEqual(["notice 0.0.1->9.9.9"]);
  });

  it("is a no-op when OMP_NO_UPDATE_CHECK is set", async () => {
    const { io, prints } = fakeIO();
    let checked = 0;
    await maybePromptUpdate({
      cwd: newProject(),
      io,
      interactive: true,
      formatUpdateNotice: baseOpts.formatUpdateNotice,
      checkForUpdate: async () => {
        checked += 1;
        return update;
      },
      env: { OMP_NO_UPDATE_CHECK: "1" },
    });
    expect(checked).toBe(0);
    expect(prints).toHaveLength(0);
  });

  it("stays silent when no update is available", async () => {
    const { io, prints, asked } = fakeIO();
    await maybePromptUpdate({
      cwd: newProject(),
      io,
      interactive: true,
      formatUpdateNotice: baseOpts.formatUpdateNotice,
      checkForUpdate: async () => null,
    });
    expect(prints).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });
});

describe("maybeWelcome", () => {
  it("prints the hint once then writes a marker", () => {
    const cwd = newProject();
    const { io, prints } = fakeIO();
    maybeWelcome({ cwd, io, interactive: true });
    expect(prints).toContain(gettingStartedHint());
    expect(existsSync(join(cwd, ".omp", "state", "welcomed"))).toBe(true);

    const second = fakeIO();
    maybeWelcome({ cwd, io: second.io, interactive: true });
    expect(second.prints).toHaveLength(0);
  });

  it("does nothing when non-interactive", () => {
    const { io, prints } = fakeIO();
    maybeWelcome({ cwd: newProject(), io, interactive: false });
    expect(prints).toHaveLength(0);
  });
});
