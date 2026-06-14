import { describe, expect, it } from "vitest";
import { makeTmux, paneHasActiveTask, paneLooksReady, sendToWorker, type TmuxResult } from "../../src/team/tmux.js";

function ok(stdout = ""): TmuxResult {
  return { stdout, stderr: "", status: 0 };
}

describe("pane content classification", () => {
  it("paneLooksReady detects shell prompt", () => {
    expect(paneLooksReady("user@host $\n")).toBe(true);
    expect(paneLooksReady("> ")).toBe(true);
    expect(paneLooksReady("Running tool...\n")).toBe(false);
    expect(paneLooksReady("")).toBe(false);
  });

  it("paneLooksReady skips Copilot CLI status bar below prompt", () => {
    const copilotOutput = [
      "● Lane A reporting: all good!",
      "───────────────────────────────────────",
      "❯",
      "───────────────────────────────────────",
      " / commands · ? help                                 Claude Opus 4.6",
      "",
      "",
    ].join("\n");
    expect(paneLooksReady(copilotOutput)).toBe(true);
  });

  it("paneHasActiveTask detects active-task markers", () => {
    expect(paneHasActiveTask("Esc to interrupt")).toBe(true);
    expect(paneHasActiveTask("background terminal running")).toBe(true);
    expect(paneHasActiveTask("just text")).toBe(false);
  });

  it("paneHasActiveTask detects Copilot CLI >=1.0.61 working state", () => {
    // Copilot 1.0.61 shows "◉ Working esc cancel" instead of "esc to interrupt".
    expect(paneHasActiveTask(" ◉ Working esc cancel                 GPT-5 mini")).toBe(true);
    expect(paneHasActiveTask("esc cancel")).toBe(true);
    // idle prompt bar must NOT read as busy
    expect(paneHasActiveTask(" / commands · ? help            GPT-5 mini")).toBe(false);
  });
});

describe("makeTmux", () => {
  it("constructs the correct args for each operation", () => {
    const calls: string[][] = [];
    const api = makeTmux((args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("0");
      if (args[0] === "has-session") return { stdout: "", stderr: "", status: 1 };
      return ok("%5");
    });
    api.newSession("s", "/tmp");
    api.splitWindow("%4", "/tmp");
    api.sendKeys("%5", "C-m");
    api.sendText("%5", "hello");
    api.displayMessage("%5", "done");
    api.capturePane("%5", 80);
    expect(api.paneDead("%5")).toBe(false);
    expect(api.sessionExists("s")).toBe(false);
    expect(calls[0]).toEqual(["new-session", "-d", "-P", "-F", "#S:0 #{pane_id}", "-s", "s", "-c", "/tmp"]);
    expect(calls[1]).toEqual(["split-window", "-h", "-t", "%4", "-d", "-P", "-F", "#{pane_id}", "-c", "/tmp"]);
    expect(calls[2]).toEqual(["send-keys", "-t", "%5", "C-m"]);
    expect(calls[3]).toEqual(["send-keys", "-t", "%5", "-l", "--", "hello"]);
    expect(calls[4]).toEqual(["display-message", "-t", "%5", "--", "done"]);
    expect(calls[5]).toEqual(["capture-pane", "-t", "%5", "-p", "-S", "-80"]);
  });
});

describe("sendToWorker", () => {
  it("sends text then Enter and stops when message disappears from capture", async () => {
    const calls: string[][] = [];
    let captureCount = 0;
    const api = makeTmux((args) => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        captureCount++;
        // After first Enter round, pretend message vanished
        return ok(captureCount === 1 ? "$ " : "$ ");
      }
      return ok();
    });
    const ok2 = await sendToWorker(api, "%1", "Hello world", { delayMs: 1 });
    expect(ok2).toBe(true);
    const sendKeysCalls = calls.filter((c) => c[0] === "send-keys");
    const enterRounds = sendKeysCalls.filter((c) => c[c.length - 1] === "Enter").length;
    expect(enterRounds).toBeGreaterThanOrEqual(1);
  });

  it("truncates payloads longer than 200 chars", async () => {
    const calls: string[][] = [];
    const api = makeTmux((args) => {
      calls.push(args);
      if (args[0] === "capture-pane") return ok("$ ");
      return ok();
    });
    const payload = "x".repeat(300);
    await sendToWorker(api, "%1", payload, { delayMs: 1 });
    const textCall = calls.find((c) => c.includes("-l"));
    expect(textCall?.[textCall.length - 1]).toHaveLength(200);
  });
});
