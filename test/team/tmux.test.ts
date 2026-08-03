import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  makeTmux,
  makeTmuxForSocket,
  paneHasActiveTask,
  paneLooksReady,
  sendToWorker,
  tmuxExec,
  type TmuxResult,
} from "../../src/team/tmux.js";

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
  it("tmuxExec returns a nonzero timeout result when tmux hangs", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "omp-tmux-timeout-"));
    try {
      const fakeTmux = path.join(tempDir, "tmux");
      const probe = path.join(tempDir, "probe.ts");
      const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
      const tmuxModule = pathToFileURL(path.resolve("src", "team", "tmux.ts")).href;
      writeFileSync(fakeTmux, "#!/bin/sh\nexec sleep 10\n");
      writeFileSync(
        probe,
        [
          `import { tmuxExec } from ${JSON.stringify(tmuxModule)};`,
          "const startedAt = Date.now();",
          'const result = tmuxExec(["display-message", "-p", "ok"]);',
          "const elapsedMs = Date.now() - startedAt;",
          "console.log(JSON.stringify({ elapsedMs, result }));",
        ].join("\n"),
      );
      chmodSync(fakeTmux, 0o700);

      const child = spawnSync(process.execPath, [tsxCli, probe], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: process.env.PATH ? `${tempDir}${path.delimiter}${process.env.PATH}` : tempDir,
        },
        timeout: 8_000,
      });
      const parsed = JSON.parse(child.stdout.trim()) as {
        elapsedMs: number;
        result: TmuxResult;
      };

      expect(child.status).toBe(0);
      expect(parsed.elapsedMs).toBeLessThan(4500);
      expect(parsed.result.status).not.toBe(0);
      expect(`${parsed.result.stderr}\n${parsed.result.stdout}`).toMatch(/timeout|timed out|ETIMEDOUT/i);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }, 15_000);

  it("constructs the correct args for each operation", () => {
    const calls: string[][] = [];
    // Empty env -> no -e passthrough args, so the base arg shapes stay exact.
    const api = makeTmux((args) => {
      calls.push(args);
      if (args[0] === "display-message") return ok("0");
      if (args[0] === "has-session") return { stdout: "", stderr: "", status: 1 };
      return ok("%5");
    }, {});
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

  it("forwards COPILOT_* (BYOK) env into new panes via -e", () => {
    const calls: string[][] = [];
    const api = makeTmux(
      (args) => {
        calls.push(args);
        return ok("%5");
      },
      { COPILOT_PROVIDER_BASE_URL: "https://openrouter.ai/api/v1", PATH: "/usr/bin" },
    );
    api.newSession("s", "/tmp");
    api.splitWindow("%4", "/tmp");
    expect(calls[0]).toEqual([
      "new-session", "-d", "-P", "-F", "#S:0 #{pane_id}", "-s", "s", "-c", "/tmp",
      "-e", "COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1",
    ]);
    expect(calls[1]).toEqual([
      "split-window", "-h", "-t", "%4", "-d", "-P", "-F", "#{pane_id}", "-c", "/tmp",
      "-e", "COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1",
    ]);
  });

  it("binds commands to one socket and reads the full pane identity", () => {
    const calls: string[][] = [];
    const api = makeTmuxForSocket(
      "/tmp/team.sock",
      (args) => {
        calls.push(args);
        return ok(
          "/tmp/team.sock|66728|1785439051|$4|1785439000|@8|%7|/work/project|0|launch-1|lane-a",
        );
      },
      {},
    );

    expect(api.paneContext?.("%7")).toEqual({
      socketPath: "/tmp/team.sock",
      serverPid: 66728,
      serverStartedAt: 1785439051,
      sessionId: "$4",
      sessionCreatedAt: 1785439000,
      windowId: "@8",
      paneId: "%7",
      currentPath: "/work/project",
      dead: false,
      launchId: "launch-1",
      laneId: "lane-a",
    });
    expect(calls[0]?.slice(0, 4)).toEqual([
      "-S",
      "/tmp/team.sock",
      "display-message",
      "-t",
    ]);
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
