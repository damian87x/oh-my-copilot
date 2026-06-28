import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Import the .mjs hook helper directly — same code the sessionEnd hook runs.
import { triggerMemoryReview, resolveMemoryReviewInvocation } from "../../scripts/lib/memory-review-trigger.mjs";

const root = () => mkdtempSync(path.join(tmpdir(), "omp-mem-hook-"));

function writeConfig(dir: string, obj: unknown) {
  mkdirSync(path.join(dir, ".omp"), { recursive: true });
  writeFileSync(path.join(dir, ".omp", "config.json"), JSON.stringify(obj));
}

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, detached: options.detached });
    return { unref: () => {} };
  };
  return { spawn, calls };
}

describe("sessionEnd hook trigger", () => {
  it("does not trigger when memory-mode is off", () => {
    const { spawn, calls } = recordingSpawn();
    expect(triggerMemoryReview({ cwd: root(), sessionId: "abc", spawn, mode: "off" }).triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not trigger without a real session id", () => {
    const { spawn, calls } = recordingSpawn();
    expect(triggerMemoryReview({ cwd: root(), sessionId: "unknown", spawn, mode: "on" }).triggered).toBe(false);
    expect(triggerMemoryReview({ cwd: root(), sessionId: "", spawn, mode: "on" }).triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("detaches memory-review with the session id when on", () => {
    const { spawn, calls } = recordingSpawn();
    const cwd = root();
    const res = triggerMemoryReview({ cwd, sessionId: "sess-9", spawn, cliPath: "/pkg/dist/src/cli.js", mode: "on" });
    expect(res.triggered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].detached).toBe(true);
    expect(calls[0].args).toEqual(["/pkg/dist/src/cli.js", "memory-review", "--session", "sess-9", "--root", cwd]);
  });
});

describe("readMemoryMode resolution (global fallback)", () => {
  const prevHome = process.env.OMP_HOME_OVERRIDE;
  const prevMode = process.env.OMP_MEMORY_MODE;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMP_HOME_OVERRIDE;
    else process.env.OMP_HOME_OVERRIDE = prevHome;
    if (prevMode === undefined) delete process.env.OMP_MEMORY_MODE;
    else process.env.OMP_MEMORY_MODE = prevMode;
  });

  it("triggers from GLOBAL ~/.omp config when the project sets no memoryMode", () => {
    delete process.env.OMP_MEMORY_MODE;
    const home = root();
    writeConfig(home, { memoryMode: "on" }); // global on
    process.env.OMP_HOME_OVERRIDE = home;
    const { spawn, calls } = recordingSpawn();
    const res = triggerMemoryReview({ cwd: root(), sessionId: "g1", spawn }); // no mode → reads config
    expect(res.triggered).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("project memoryMode=off overrides global on", () => {
    delete process.env.OMP_MEMORY_MODE;
    const home = root();
    writeConfig(home, { memoryMode: "on" });
    process.env.OMP_HOME_OVERRIDE = home;
    const cwd = root();
    writeConfig(cwd, { memoryMode: "off" }); // project overrides
    const { spawn, calls } = recordingSpawn();
    expect(triggerMemoryReview({ cwd, sessionId: "g2", spawn }).triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveMemoryReviewInvocation (fresh-install CLI resolution)", () => {
  it("runs via node when a bundled dist exists (npm package / dev build)", () => {
    const inv = resolveMemoryReviewInvocation({ sessionId: "s", cwd: "/c", distPath: "/p/dist/cli.js", exists: () => true });
    expect(inv.command).toBe(process.execPath);
    expect(inv.args).toEqual(["/p/dist/cli.js", "memory-review", "--session", "s", "--root", "/c"]);
  });

  it("falls back to the global `omp` on PATH when no dist is bundled (plugin from GitHub)", () => {
    const inv = resolveMemoryReviewInvocation({ sessionId: "s", cwd: "/c", distPath: "/missing/cli.js", exists: () => false });
    expect(inv.command).toBe("omp");
    expect(inv.args).toEqual(["memory-review", "--session", "s", "--root", "/c"]);
  });
});
