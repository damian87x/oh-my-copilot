import { describe, expect, it } from "vitest";
import { DEFAULT_NUDGE_CONFIG, NudgeTracker } from "../../src/team/idle-nudge.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";

function ok(stdout = ""): TmuxResult {
  return { stdout, stderr: "", status: 0 };
}

function makeApi(captureByPane: Record<string, string>): { api: TmuxApi; calls: string[][] } {
  const calls: string[][] = [];
  const api: TmuxApi = {
    newSession: () => ok(),
    splitWindow: () => ok(),
    sendKeys(target, ...keys) {
      calls.push(["send-keys", target, ...keys]);
      return ok();
    },
    sendText(target, text) {
      calls.push(["send-text", target, text]);
      return ok();
    },
    capturePane(target) {
      calls.push(["capture-pane", target]);
      return ok(captureByPane[target] ?? "");
    },
    killPane: () => ok(),
    killSession: () => ok(),
    paneDead: () => false,
    sessionExists: () => false,
  };
  return { api, calls };
}

describe("NudgeTracker", () => {
  it("does not nudge before the idle grace period", async () => {
    const { api } = makeApi({ "%1": "$ " });
    const tracker = new NudgeTracker({ delayMs: 30_000, scanIntervalMs: 0 });
    const t = 1_000_000;
    const result = await tracker.checkAndNudge(api, "s", ["%1"], undefined, t);
    expect(result).toEqual([]);
    const result2 = await tracker.checkAndNudge(api, "s", ["%1"], undefined, t + 1_000);
    expect(result2).toEqual([]);
  });

  it("nudges after delayMs of idle time, then resets the idle timer", async () => {
    const { api, calls } = makeApi({ "%1": "$ " });
    const tracker = new NudgeTracker({ delayMs: 30_000, scanIntervalMs: 0, maxCount: 3 });
    const t0 = 1_000_000;
    await tracker.checkAndNudge(api, "s", ["%1"], undefined, t0);
    const second = await tracker.checkAndNudge(api, "s", ["%1"], undefined, t0 + 30_001);
    expect(second).toHaveLength(1);
    expect(second[0]?.nudgeCount).toBe(1);
    expect(calls.some((c) => c[0] === "send-text" && c[1] === "%1")).toBe(true);
    // After a nudge the idle timer resets — calling again immediately should NOT nudge again
    const third = await tracker.checkAndNudge(api, "s", ["%1"], undefined, t0 + 30_002);
    expect(third).toEqual([]);
  });

  it("stops nudging after maxCount nudges", async () => {
    const { api } = makeApi({ "%1": "$ " });
    const tracker = new NudgeTracker({ delayMs: 100, scanIntervalMs: 0, maxCount: 2 });
    let t = 0;
    for (let round = 0; round < 5; round++) {
      await tracker.checkAndNudge(api, "s", ["%1"], undefined, t);
      t += 200;
    }
    const summary = tracker.getSummary();
    expect(summary[0]?.nudgeCount).toBe(2);
  });

  it("skips the leader pane", async () => {
    const { api } = makeApi({ "%1": "$ ", "%2": "$ " });
    const tracker = new NudgeTracker({ delayMs: 100, scanIntervalMs: 0 });
    const result = await tracker.checkAndNudge(api, "s", ["%1", "%2"], "%1", 1_000);
    const result2 = await tracker.checkAndNudge(api, "s", ["%1", "%2"], "%1", 1_200);
    expect(result).toEqual([]);
    expect(result2.map((a) => a.paneId)).toEqual(["%2"]);
  });

  it("does not nudge when the pane shows an active task", async () => {
    const { api } = makeApi({ "%1": "$ esc to interrupt" });
    const tracker = new NudgeTracker({ delayMs: 100, scanIntervalMs: 0 });
    const result = await tracker.checkAndNudge(api, "s", ["%1"], undefined, 1_000);
    const result2 = await tracker.checkAndNudge(api, "s", ["%1"], undefined, 1_200);
    expect(result).toEqual([]);
    expect(result2).toEqual([]);
  });

  it("throttles by scanIntervalMs", async () => {
    const { api, calls } = makeApi({ "%1": "$ " });
    const tracker = new NudgeTracker({ delayMs: 0, scanIntervalMs: 5_000 });
    await tracker.checkAndNudge(api, "s", ["%1"], undefined, 1_000);
    const captureCallsBefore = calls.filter((c) => c[0] === "capture-pane").length;
    await tracker.checkAndNudge(api, "s", ["%1"], undefined, 2_000); // within 5s window
    const captureCallsAfter = calls.filter((c) => c[0] === "capture-pane").length;
    expect(captureCallsAfter).toBe(captureCallsBefore);
  });

  it("resets state via reset()", async () => {
    const { api } = makeApi({ "%1": "$ " });
    const tracker = new NudgeTracker({ delayMs: 100, scanIntervalMs: 0 });
    await tracker.checkAndNudge(api, "s", ["%1"], undefined, 1_000);
    await tracker.checkAndNudge(api, "s", ["%1"], undefined, 1_200);
    expect(tracker.getSummary()).toHaveLength(1);
    tracker.reset();
    expect(tracker.getSummary()).toHaveLength(0);
  });

  it("exposes default config knobs", () => {
    expect(DEFAULT_NUDGE_CONFIG.delayMs).toBe(30_000);
    expect(DEFAULT_NUDGE_CONFIG.maxCount).toBe(3);
    expect(DEFAULT_NUDGE_CONFIG.scanIntervalMs).toBe(5_000);
  });
});
