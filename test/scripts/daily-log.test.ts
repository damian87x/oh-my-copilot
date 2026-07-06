import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs hook helper exports are exercised from tests.
import { recordPrompt, startSession } from "../../scripts/lib/daily-log.mjs";

const fixtures: string[] = [];

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-script-daily-log-"));
  fixtures.push(root);
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function stateFile(root: string) {
  return path.join(root, ".omp", "state", "daily-log.json");
}

function locksPath(root: string) {
  return path.join(root, ".omp", "state", "locks");
}

function readState(root: string) {
  return JSON.parse(readFileSync(stateFile(root), "utf8")) as { prompts: number };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts daily-log prompt dedup", () => {
  it("dedupes same-session same-prompt records within a minute bucket", () => {
    const root = makeFixture();
    startSession(root);

    recordPrompt(root, {
      sessionId: "sid/with:chars",
      prompt: "continue",
      timestamp: "2026-07-05T12:34:05.000Z",
    });
    recordPrompt(root, {
      sessionId: "sid/with:chars",
      prompt: "continue",
      timestamp: "2026-07-05T12:34:30.000Z",
    });
    expect(readState(root).prompts).toBe(1);

    // Accepted residual exposure: a double-fire straddling a minute boundary is
    // counted rather than tightening the key and suppressing legitimate repeats.
    recordPrompt(root, {
      sessionId: "sid/with:chars",
      prompt: "continue",
      timestamp: "2026-07-05T12:35:00.000Z",
    });
    recordPrompt(root, {
      sessionId: "sid/with:chars",
      prompt: "different prompt",
      timestamp: "2026-07-05T12:35:10.000Z",
    });

    expect(readState(root).prompts).toBe(3);
    expect(existsSync(locksPath(root))).toBe(true);
  });

  it("fails open toward counting when the prompt marker guard errors", () => {
    const root = makeFixture();
    startSession(root);
    writeFileSync(locksPath(root), "not a directory", "utf8");

    recordPrompt(root, {
      sessionId: "s1",
      prompt: "continue",
      timestamp: "2026-07-05T12:34:05.000Z",
    });

    expect(readState(root).prompts).toBe(1);
  });
});
