import { describe, expect, it, vi } from "vitest";
import {
  createInitialPaneState,
  evaluatePaneState,
  monitorPanes,
} from "../../src/team/pane-monitor.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";

function mockTmux(
  capturedByPane: Record<string, string>,
  deadPanes: Set<string> = new Set(),
): TmuxApi & { displayMessage: ReturnType<typeof vi.fn>; sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn((target: string, text: string) => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult));
  return {
    newSession: () => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult),
    splitWindow: () => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult),
    sendKeys: () => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult),
    sendText,
    displayMessage: vi.fn(() => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult)),
    capturePane: (target: string) =>
      ({ stdout: capturedByPane[target] ?? "", stderr: "", status: 0 } satisfies TmuxResult),
    killPane: () => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult),
    killSession: () => ({ stdout: "", stderr: "", status: 0 } satisfies TmuxResult),
    paneDead: (target: string) => deadPanes.has(target),
    sessionExists: () => false,
  };
}

describe("evaluatePaneState", () => {
  it("does not notify immediately on a ready pane without enough observation time", () => {
    const initial = createInitialPaneState(0);
    const result = evaluatePaneState(initial, "❯ ", false, "%2", 5_000, { readySamples: 2, minObservationMs: 10_000 }, "demo");
    expect(result.event).toBeUndefined();
    expect(result.state.done).toBe(false);
  });

  it("notifies when a previously active pane becomes ready twice", () => {
    let state = createInitialPaneState(0);
    state = evaluatePaneState(state, "Esc to interrupt", false, "%2", 1_000, { readySamples: 2, minObservationMs: 10_000 }, "demo").state;
    state = evaluatePaneState(state, "❯ ", false, "%2", 2_000, { readySamples: 2, minObservationMs: 10_000 }, "demo").state;
    const result = evaluatePaneState(state, "❯ ", false, "%2", 3_000, { readySamples: 2, minObservationMs: 10_000 }, "demo");
    expect(result.event?.kind).toBe("ready");
    expect(result.state.done).toBe(true);
  });

  it("notifies for a fast-completing pane once it has been observed long enough", () => {
    let state = createInitialPaneState(0);
    state = evaluatePaneState(state, "❯ ", false, "%2", 11_000, { readySamples: 2, minObservationMs: 10_000 }, "demo").state;
    const result = evaluatePaneState(state, "❯ ", false, "%2", 14_500, { readySamples: 2, minObservationMs: 10_000 }, "demo");
    expect(result.event?.kind).toBe("ready");
  });

  it("notifies when a pane dies", () => {
    const initial = createInitialPaneState(0);
    const result = evaluatePaneState(initial, "", true, "%2", 1_000, { readySamples: 2, minObservationMs: 10_000 }, "demo");
    expect(result.event?.kind).toBe("dead");
    expect(result.state.done).toBe(true);
  });
});

describe("monitorPanes", () => {
  it("displays a leader message when a worker becomes ready", async () => {
    const panes = {
      "%2": "○ Working esc cancel",
    };
    const tmux = mockTmux(panes);
    let reads = 0;
    tmux.capturePane = (target: string) => {
      reads++;
      return {
        stdout: reads >= 2 ? "❯ " : panes[target] ?? "",
        stderr: "",
        status: 0,
      } satisfies TmuxResult;
    };

    const result = await monitorPanes({
      leaderPaneId: "%1",
      workerPaneIds: ["%2"],
      sessionLabel: "demo",
      tmux,
      config: { pollIntervalMs: 1, readySamples: 2, minObservationMs: 0, timeoutMs: 100, captureLines: 20 },
    });

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(tmux.sendText).toHaveBeenCalledWith("%1", expect.stringContaining("ready for review"));
  });
});
