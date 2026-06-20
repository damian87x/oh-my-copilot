import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isHeadless, triggerHeadlessReview, type DetachSpawn } from "../../src/memory-review/trigger.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-trig-"));

interface Call {
  command: string;
  args: string[];
  detached: boolean;
  events: string[];
}
function recordingSpawn(): { spawn: DetachSpawn; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: DetachSpawn = (command, args, options) => {
    const events: string[] = [];
    calls.push({ command, args, detached: options.detached, events });
    return { unref: () => {}, on: (event: string) => { events.push(event); } };
  };
  return { spawn, calls };
}

describe("isHeadless", () => {
  it("detects -p / --prompt", () => {
    expect(isHeadless(["-p", "do it"])).toBe(true);
    expect(isHeadless(["--prompt", "x"])).toBe(true);
    expect(isHeadless(["--madmax"])).toBe(false);
    expect(isHeadless([])).toBe(false);
  });
});

describe("triggerHeadlessReview", () => {
  const base = { cliPath: "/pkg/dist/src/cli.js", sessionId: "real-uuid", modeOverride: "on" as const };

  it("does not trigger for an interactive (non -p) launch", () => {
    const { spawn, calls } = recordingSpawn();
    const res = triggerHeadlessReview({ ...base, cwd: root(), argv: ["--madmax"], spawn });
    expect(res.triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not trigger when memory-mode is off", () => {
    const { spawn, calls } = recordingSpawn();
    const res = triggerHeadlessReview({ ...base, cwd: root(), argv: ["-p", "x"], spawn, modeOverride: "off" });
    expect(res.triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not guess: skips when no concrete session id is provided", () => {
    const { spawn, calls } = recordingSpawn();
    const res = triggerHeadlessReview({ ...base, cwd: root(), argv: ["-p", "x"], spawn, sessionId: "" });
    expect(res.triggered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("detaches a memory-review for the EXACT session id (not 'latest')", () => {
    const { spawn, calls } = recordingSpawn();
    const cwd = root();
    const res = triggerHeadlessReview({ ...base, cwd, argv: ["-p", "ship it"], spawn });
    expect(res.triggered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].detached).toBe(true);
    expect(calls[0].args).toEqual(["/pkg/dist/src/cli.js", "memory-review", "--session", "real-uuid", "--root", cwd]);
    expect(calls[0].args).not.toContain("latest");
    // fail-open: an async spawn error must be handled, not thrown unhandled
    expect(calls[0].events).toContain("error");
  });
});
