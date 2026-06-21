import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Import the .mjs hook helper directly — same code the sessionEnd hook runs.
import { triggerMemoryReview, resolveMemoryReviewInvocation } from "../../scripts/lib/memory-review-trigger.mjs";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-hook-"));

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
