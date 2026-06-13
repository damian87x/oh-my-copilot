import { describe, it, expect } from "vitest";
import { makeTmux, type TmuxRunner } from "../src/team/tmux.js";
import {
  stripAnsi,
  checkOnline,
  commsStatus,
  commsSend,
  commsRecv,
  commsAsk,
  newOutputSince,
} from "../src/comms/index.js";

interface FakeOpts {
  exists?: boolean;
  capture?: string;
  captureStatus?: number;
  sendStatus?: number;
}

function fakeTmux(opts: FakeOpts) {
  const calls: string[][] = [];
  const runner: TmuxRunner = (args) => {
    calls.push(args);
    const sub = args[0];
    if (sub === "has-session") {
      return { stdout: "", stderr: "", status: opts.exists ? 0 : 1 };
    }
    if (sub === "capture-pane") {
      return { stdout: opts.capture ?? "", stderr: "", status: opts.captureStatus ?? 0 };
    }
    if (sub === "send-keys") {
      return { stdout: "", stderr: "", status: opts.sendStatus ?? 0 };
    }
    return { stdout: "", stderr: "", status: 0 };
  };
  return { tmux: makeTmux(runner), calls };
}

const noSleep = async () => {};
const READY_PANE = "task done\nuser@host $";
const BUSY_PANE = "thinking... (esc to interrupt)";

describe("stripAnsi", () => {
  it("removes color escape sequences", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world $")).toBe("hello world $");
  });
  it("strips an OSC hyperlink sequence", () => {
    expect(stripAnsi("]8;;https://xlabel]8;;")).toBe("label");
  });
  it("strips a cursor/clear CSI sequence", () => {
    expect(stripAnsi("[2Jcleared")).toBe("cleared");
  });
  it("tolerates a truncated OSC without eating the whole buffer", () => {
    // capture-pane can cut mid-OSC; must not greedily consume earlier text.
    expect(stripAnsi("before]0;truncated")).toBe("before");
  });
});

describe("checkOnline", () => {
  it("returns true when the connector succeeds", async () => {
    expect(await checkOnline({}, async () => true)).toBe(true);
  });
  it("returns false when the connector fails", async () => {
    expect(await checkOnline({}, async () => false)).toBe(false);
  });
  it("returns false when the connector throws", async () => {
    expect(
      await checkOnline({}, async () => {
        throw new Error("boom");
      }),
    ).toBe(false);
  });
});

describe("commsStatus", () => {
  it("reports a running, online, ready session", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: READY_PANE });
    const r = await commsStatus("omp-x", { tmux, isOnline: async () => true });
    expect(r).toMatchObject({ exists: true, online: true, ready: true, busy: false });
  });

  it("reports a missing session as not ready", async () => {
    const { tmux } = fakeTmux({ exists: false });
    const r = await commsStatus("omp-x", { tmux, isOnline: async () => false });
    expect(r).toMatchObject({ exists: false, online: false, ready: false });
  });

  it("detects a busy pane", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: BUSY_PANE });
    const r = await commsStatus("omp-x", { tmux, isOnline: async () => true });
    expect(r.busy).toBe(true);
  });
});

describe("commsSend", () => {
  it("refuses an empty message", async () => {
    const { tmux } = fakeTmux({ exists: true });
    const r = await commsSend("omp-x", "   ", { tmux, isOnline: async () => true, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/);
  });

  it("refuses a multi-line message", async () => {
    const { tmux } = fakeTmux({ exists: true });
    const r = await commsSend("omp-x", "line1\nline2", {
      tmux,
      isOnline: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/multi-line/);
  });

  it("refuses when the session is not running", async () => {
    const { tmux } = fakeTmux({ exists: false });
    const r = await commsSend("omp-x", "hi", { tmux, isOnline: async () => true, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running/);
  });

  it("refuses when offline", async () => {
    const { tmux } = fakeTmux({ exists: true });
    const r = await commsSend("omp-x", "hi", { tmux, isOnline: async () => false, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offline/);
  });

  it("does not probe connectivity when the session is missing", async () => {
    const { tmux } = fakeTmux({ exists: false });
    let onlineCalled = false;
    const r = await commsSend("omp-x", "hi", {
      tmux,
      isOnline: async () => {
        onlineCalled = true;
        return true;
      },
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(onlineCalled).toBe(false);
  });

  it("fails when a tmux send-keys command errors", async () => {
    const { tmux } = fakeTmux({ exists: true, sendStatus: 1 });
    const r = await commsSend("omp-x", "hi", { tmux, isOnline: async () => true, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/send-keys failed/);
  });

  it("refuses to send while the pane is busy", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: BUSY_PANE });
    const r = await commsSend("omp-x", "hi", { tmux, isOnline: async () => true, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/busy/);
  });

  it("sends while busy when forced", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: BUSY_PANE });
    const r = await commsSend(
      "omp-x",
      "hi",
      { tmux, isOnline: async () => true, sleep: noSleep },
      { force: true },
    );
    expect(r.ok).toBe(true);
  });

  it("sends text and a single Enter when on + online", async () => {
    const { tmux, calls } = fakeTmux({ exists: true });
    const r = await commsSend("omp-x", "hello copilot", {
      tmux,
      isOnline: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(true);
    const sendText = calls.find((c) => c[0] === "send-keys" && c.includes("-l"));
    const enter = calls.filter((c) => c[0] === "send-keys" && c.includes("Enter"));
    expect(sendText).toContain("hello copilot");
    expect(enter).toHaveLength(1);
  });

  it("returns ok:false when the prompt never leaves the input buffer", async () => {
    // Models the swallow-forever case: the prompt stays on the input line no
    // matter how many times Enter is pressed.
    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "has-session") return { stdout: "", stderr: "", status: 0 };
      if (args[0] === "capture-pane") {
        return { stdout: "task done\n❯ hello copilot", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const r = await commsSend("omp-x", "hello copilot", {
      tmux: makeTmux(runner),
      isOnline: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(false);
    expect(r.submitted).toBe(false);
  });

  it("re-sends Enter when the first C-m is swallowed and the prompt stays buffered", async () => {
    // Reproduces the Copilot CLI >=1.0.61 bug: a C-m right after a bracketed
    // paste is absorbed, so the prompt sits unsent in the input line until a
    // second Enter submits it.
    const calls: string[][] = [];
    let textSent = false;
    let enters = 0;
    const EMPTY = "task done\n❯ ";
    const BUFFERED = "task done\n❯ hello copilot";
    const CLEARED = "❯ hello copilot\n● reply\n❯ \n / commands · ? help";
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      const sub = args[0];
      if (sub === "has-session") return { stdout: "", stderr: "", status: 0 };
      if (sub === "send-keys") {
        if (args.includes("-l")) textSent = true;
        if (args.includes("Enter")) enters++;
        return { stdout: "", stderr: "", status: 0 };
      }
      if (sub === "capture-pane") {
        const pane = !textSent ? EMPTY : enters < 2 ? BUFFERED : CLEARED;
        return { stdout: pane, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const r = await commsSend("omp-x", "hello copilot", {
      tmux: makeTmux(runner),
      isOnline: async () => true,
      sleep: noSleep,
    });
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(true);
    const entersSent = calls.filter((c) => c[0] === "send-keys" && c.includes("Enter"));
    expect(entersSent).toHaveLength(2);
  });
});

describe("commsRecv", () => {
  it("returns ANSI-stripped pane text", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: "[32mresult[0m" });
    const r = await commsRecv("omp-x", { tmux });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("result");
  });

  it("refuses when the session is not running", async () => {
    const { tmux } = fakeTmux({ exists: false });
    const r = await commsRecv("omp-x", { tmux });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not running/);
  });

  it("fails when the capture command errors", async () => {
    const { tmux } = fakeTmux({ exists: true, captureStatus: 1 });
    const r = await commsRecv("omp-x", { tmux });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failed to read/);
  });

  it("with wait, returns once the pane is idle", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: READY_PANE });
    const r = await commsRecv("omp-x", { tmux, sleep: noSleep }, { wait: true, timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("with wait, times out when the pane stays busy", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: BUSY_PANE });
    const r = await commsRecv(
      "omp-x",
      { tmux, sleep: noSleep },
      { wait: true, timeoutMs: 5, pollMs: 1 },
    );
    expect(r.ok).toBe(true);
    expect(r.timedOut).toBe(true);
  });
});

describe("newOutputSince", () => {
  it("returns only lines added after the baseline", () => {
    expect(newOutputSince("old\n>", "old\n>\nnew q\nANSWER\n>")).toBe("new q\nANSWER");
  });
  it("returns empty when nothing changed", () => {
    expect(newOutputSince("a\n>", "a\n>")).toBe("");
  });
  it("returns all content (minus trailing prompt) when baseline is empty", () => {
    expect(newOutputSince("", "fresh\n>")).toBe("fresh");
  });
});

describe("commsAsk", () => {
  it("isolates the new reply after sending", async () => {
    let captures = 0;
    const runner: TmuxRunner = (args) => {
      if (args[0] === "has-session") return { stdout: "", stderr: "", status: 0 };
      if (args[0] === "capture-pane") {
        captures += 1;
        // First capture is the baseline; subsequent captures include the reply
        // and an idle prompt so the wait loop resolves.
        const out = captures === 1 ? "prompt\n>" : "prompt\n>\nWhat is 2+2?\n4\n>";
        return { stdout: out, stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    };
    const tmux = makeTmux(runner);
    const r = await commsAsk("omp-x", "What is 2+2?", { tmux, isOnline: async () => true, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.text).toContain("4");
  });

  it("does not send when offline", async () => {
    const { tmux } = fakeTmux({ exists: true, capture: "prompt\n>" });
    const r = await commsAsk("omp-x", "hi", { tmux, isOnline: async () => false, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.sent).toBe(false);
  });
});
