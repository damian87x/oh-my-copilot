import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearModeState, writeModeStateJson } from "../../src/mode-state/paths.js";
import { scanLoopTeamMonitorOnce } from "../../src/team/loop-monitor.js";
import {
  adoptLoopTeamMonitorOwner,
  ensureLoopTeamMonitor,
  runLoopTeamMonitor,
  type MonitorSpawn,
} from "../../src/team/monitor-supervisor.js";
import {
  ensureTeamDirs,
  ensureTeamMonitorDirs,
  resolveTeamMonitorPaths,
  resolveTeamPaths,
} from "../../src/team/state-paths.js";
import type { TeamConfig } from "../../src/team/types.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";

function tempProject(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "omc-loop-monitor-"));
  writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf8");
  return cwd;
}

function writeRuntimeTeam(
  cwd: string,
  name = "demo",
  paneId = "%2",
): void {
  const paths = resolveTeamPaths(cwd, name);
  ensureTeamDirs(paths);
  const config: TeamConfig = {
    name,
    task: "ship issue 110",
    role: "copilot",
    workerCount: 1,
    tmuxSession: `omp-team-${name}`,
    tmuxIdentity: {
      socketPath: "/tmp/omc-runtime.sock",
      serverPid: 9001,
      serverStartedAt: 1785430000,
      sessionId: "$1",
      sessionCreatedAt: 1785430001,
      windowId: "@1",
    },
    workers: [{ name: "worker-1", paneId, taskId: "1" }],
    cwd,
    createdAt: "2026-07-30T18:00:00.000Z",
  };
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function ok(stdout = ""): TmuxResult {
  return { stdout, stderr: "", status: 0 };
}

function readyTmux(
  cwd = process.cwd(),
  context: Partial<NonNullable<ReturnType<NonNullable<TmuxApi["paneContext"]>>>> = {},
): TmuxApi {
  return {
    newSession: () => ok(),
    splitWindow: () => ok(),
    sendKeys: () => ok(),
    sendText: () => ok(),
    displayMessage: () => ok(),
    capturePane: () => ok("$ "),
    killPane: () => ok(),
    killSession: () => ok(),
    paneDead: () => false,
    sessionExists: () => true,
    listSessions: () => ["omp-team-demo"],
    paneContext: (target) => ({
      socketPath: "/tmp/omc-runtime.sock",
      serverPid: 9001,
      serverStartedAt: 1785430000,
      sessionId: "$1",
      sessionCreatedAt: 1785430001,
      windowId: "@1",
      paneId: target,
      currentPath: cwd,
      dead: false,
      launchId: "",
      laneId: "",
      ...context,
    }),
  };
}

describe("ensureLoopTeamMonitor", () => {
  it("does not create monitor state or spawn when no loop is active", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    let spawnCount = 0;

    const result = ensureLoopTeamMonitor(cwd, {
      spawn: () => {
        spawnCount += 1;
        return { on: () => undefined, unref: () => undefined };
      },
      cliPath: "/pkg/dist/src/cli.js",
      token: () => "owner-token",
    });

    expect(result).toEqual({ started: false, reason: "no-active-loop" });
    expect(spawnCount).toBe(0);
    expect(existsSync(resolveTeamMonitorPaths(cwd).root)).toBe(false);
  });

  it("starts exactly one detached watcher when a runtime team already exists and Ralph starts", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });

    const calls: Array<{
      command: string;
      args: string[];
      options: { detached: boolean; stdio: "ignore" };
      unrefCount: number;
    }> = [];
    const spawn: MonitorSpawn = (command, args, options) => {
      const call = { command, args, options, unrefCount: 0 };
      calls.push(call);
      return {
        on: () => undefined,
        unref: () => {
          call.unrefCount += 1;
        },
      };
    };

    const deps = {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => Date.parse("2026-07-30T19:00:00.000Z"),
      token: () => "owner-token",
      pid: 4242,
    };
    const first = ensureLoopTeamMonitor(cwd, deps);
    const second = ensureLoopTeamMonitor(cwd, deps);

    expect(first).toMatchObject({ started: true, token: "owner-token" });
    expect(second).toMatchObject({ started: false, reason: "already-pending" });
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: [
          "/pkg/dist/src/cli.js",
          "team",
          "monitor-loop",
          "--root",
          cwd,
          "--token",
          "owner-token",
        ],
        options: { detached: true, stdio: "ignore" },
        unrefCount: 1,
      },
    ]);
  });

  it("reclaims a parseable but schema-invalid owner instead of blocking forever", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const paths = resolveTeamMonitorPaths(cwd);
    ensureTeamMonitorDirs(paths);
    writeFileSync(
      paths.ownerFile,
      `${JSON.stringify({
        schemaVersion: 1,
        token: "corrupt-owner",
        phase: "unknown",
        parentPid: 4242,
        createdAt: "not-a-time",
      })}\n`,
      "utf8",
    );

    const result = ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      token: () => "healthy-owner",
    });

    expect(result).toMatchObject({
      started: true,
      token: "healthy-owner",
    });
    expect(JSON.parse(readFileSync(paths.ownerFile, "utf8"))).toMatchObject({
      token: "healthy-owner",
      phase: "pending",
    });
  });

  it("reclaims a pending owner that never heartbeats after the startup grace", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });

    let spawnCount = 0;
    const spawn: MonitorSpawn = () => {
      spawnCount += 1;
      return { on: () => undefined, unref: () => undefined };
    };
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");

    const first = ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-one",
    });
    const replacement = ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt + 15_001,
      token: () => "owner-two",
    });

    expect(first).toMatchObject({ started: true, token: "owner-one" });
    expect(replacement).toMatchObject({ started: true, token: "owner-two" });
    expect(spawnCount).toBe(2);
  });

  it("releases a synchronous spawn failure, records it, and allows immediate retry", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");

    const failed = ensureLoopTeamMonitor(cwd, {
      spawn: () => {
        throw new Error("spawn exploded");
      },
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "failed-owner",
    });
    const paths = resolveTeamMonitorPaths(cwd);

    expect(failed).toEqual({
      started: false,
      reason: "spawn-failed",
      error: "spawn exploded",
    });
    expect(existsSync(paths.ownerFile)).toBe(false);
    expect(
      readFileSync(paths.eventsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .at(-1),
    ).toMatchObject({
      type: "spawn-failed",
      token: "failed-owner",
      message: "spawn exploded",
    });

    expect(
      ensureLoopTeamMonitor(cwd, {
        spawn: () => ({ on: () => undefined, unref: () => undefined }),
        cliPath: "/pkg/dist/src/cli.js",
        now: () => startedAt + 1,
        token: () => "healthy-owner",
      }),
    ).toMatchObject({ started: true, token: "healthy-owner" });
  });

  it("keeps only the latest 100 lifecycle diagnostics", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");

    for (let index = 0; index < 105; index++) {
      ensureLoopTeamMonitor(cwd, {
        spawn: () => {
          throw new Error(`failure-${index}`);
        },
        cliPath: "/pkg/dist/src/cli.js",
        now: () => startedAt + index,
        token: () => `failed-owner-${index}`,
      });
    }

    const events = readFileSync(
      resolveTeamMonitorPaths(cwd).eventsFile,
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(100);
    expect(events[0]).toMatchObject({ message: "failure-5" });
    expect(events.at(-1)).toMatchObject({ message: "failure-104" });
  });

  it("does not let a late pre-heartbeat child callback remove a successor owner", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    const listeners = new Map<
      string,
      (...args: unknown[]) => void
    >();

    expect(
      ensureLoopTeamMonitor(cwd, {
        spawn: () => ({
          on: (event, listener) => {
            listeners.set(event, listener);
          },
          unref: () => undefined,
        }),
        cliPath: "/pkg/dist/src/cli.js",
        now: () => startedAt,
        token: () => "first-owner",
      }),
    ).toMatchObject({ started: true, token: "first-owner" });

    listeners.get("error")?.(new Error("child failed before heartbeat"));
    expect(
      ensureLoopTeamMonitor(cwd, {
        spawn: () => ({ on: () => undefined, unref: () => undefined }),
        cliPath: "/pkg/dist/src/cli.js",
        now: () => startedAt + 1,
        token: () => "successor-owner",
      }),
    ).toMatchObject({ started: true, token: "successor-owner" });

    listeners.get("exit")?.(1);
    expect(
      JSON.parse(
        readFileSync(resolveTeamMonitorPaths(cwd).ownerFile, "utf8"),
      ),
    ).toMatchObject({ token: "successor-owner", phase: "pending" });
  });

  it("replaces a running owner only after its heartbeat becomes stale", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    let spawnCount = 0;
    const spawn: MonitorSpawn = () => {
      spawnCount += 1;
      return { on: () => undefined, unref: () => undefined };
    };

    ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-one",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-one", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const fresh = ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt + 20_000,
      token: () => "owner-two",
    });
    const replacement = ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt + 20_002,
      token: () => "owner-two",
    });

    expect(fresh).toEqual({ started: false, reason: "already-running" });
    expect(replacement).toMatchObject({ started: true, token: "owner-two" });
    expect(spawnCount).toBe(2);
  });

  it("lets only the matching child adopt the pending owner and publish its first heartbeat", () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");

    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
      pid: 4242,
    });

    const rejected = adoptLoopTeamMonitorOwner(cwd, "wrong-token", {
      now: () => startedAt + 1,
      pid: 7000,
      buildId: "test-build",
    });
    const adopted = adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 2,
      pid: 7001,
      buildId: "test-build",
    });

    expect(rejected).toEqual({ adopted: false, reason: "owner-mismatch" });
    expect(adopted).toEqual({ adopted: true });

    const paths = resolveTeamMonitorPaths(cwd);
    expect(JSON.parse(readFileSync(paths.ownerFile, "utf8"))).toMatchObject({
      token: "owner-token",
      phase: "running",
      pid: 7001,
    });
    expect(JSON.parse(readFileSync(paths.heartbeatFile, "utf8"))).toMatchObject({
      token: "owner-token",
      pid: 7001,
      buildId: "test-build",
      lastHeartbeatAt: new Date(startedAt + 2).toISOString(),
    });
  });

  it("releases its owner and exits after the final loop clears", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const now = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => now,
      token: () => "owner-token",
    });

    let scans = 0;
    const result = await runLoopTeamMonitor(cwd, "owner-token", {
      buildId: "test-build",
      now: () => now + 1,
      pid: 7001,
      scan: async () => {
        scans += 1;
        clearModeState(cwd, "ralph");
        return { targetsScanned: 1, attempts: [], diagnostics: [] };
      },
      sleep: async () => {
        throw new Error("must not sleep after the final loop clears");
      },
    });

    expect(result).toEqual({ ok: true, reason: "no-active-loop", scans: 1 });
    expect(scans).toBe(1);
    const paths = resolveTeamMonitorPaths(cwd);
    expect(existsSync(paths.ownerFile)).toBe(false);
    expect(JSON.parse(readFileSync(paths.statusFile, "utf8"))).toMatchObject({
      token: "owner-token",
      terminal: true,
      reason: "no-active-loop",
      scans: 1,
    });
  });
});

describe("scanLoopTeamMonitorOnce", () => {
  it("persists a write-ahead reservation before sending to an idle runtime pane", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const tmux = readyTmux(cwd);
    const monitorPaths = resolveTeamMonitorPaths(cwd);
    const sends: string[] = [];
    const messages: string[] = [];
    const deps = {
      tmux,
      attemptId: () => "attempt-1",
      send: async (_tmux: TmuxApi, paneId: string, message: string) => {
        const targetFile = readdirSync(monitorPaths.targetsDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => path.join(monitorPaths.targetsDir, name))[0]!;
        const beforeTransport = JSON.parse(readFileSync(targetFile, "utf8"));
        expect(beforeTransport.tracker.panes[0]).toMatchObject({
          paneId: "%2",
          nudgeCount: 1,
          lastAttempt: { attemptId: "attempt-1", outcome: "reserved" },
        });
        sends.push(paneId);
        messages.push(message);
        return true;
      },
    };

    const first = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      ...deps,
      now: () => startedAt + 10,
    });
    const second = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      ...deps,
      now: () => startedAt + 30_011,
    });

    expect(first.attempts).toEqual([]);
    expect(second.attempts).toHaveLength(1);
    expect(sends).toEqual(["%2"]);
    expect(messages).toEqual([
      "Continue working on your assigned task and report concrete progress (not ACK-only).",
    ]);

    const targetFile = readdirSync(monitorPaths.targetsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(monitorPaths.targetsDir, name))[0]!;
    expect(JSON.parse(readFileSync(targetFile, "utf8")).tracker.panes[0]).toMatchObject({
      nudgeCount: 1,
      lastAttempt: { attemptId: "attempt-1", outcome: "sent" },
    });
  });

  it("removes a stale target lock and acquires it on the next scan", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const paths = resolveTeamMonitorPaths(cwd);
    const tmux = readyTmux(cwd);
    await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      tmux,
      now: () => startedAt + 10,
    });
    const targetName = readdirSync(paths.targetsDir).find((name) =>
      name.endsWith(".json"),
    )!;
    const lockFile = path.join(
      paths.targetsDir,
      `${targetName.slice(0, -".json".length)}.lock`,
    );
    writeFileSync(
      lockFile,
      `${JSON.stringify({
        token: "stale-target-lock",
        acquiredAt: new Date(startedAt).toISOString(),
        pid: 9999,
      })}\n`,
      "utf8",
    );

    const sends: string[] = [];
    const blocked = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      tmux,
      now: () => startedAt + 30_011,
      attemptId: () => "attempt-after-stale-lock",
      send: async (_api, paneId) => {
        sends.push(paneId);
        return true;
      },
    });

    expect(blocked.attempts).toEqual([]);
    expect(blocked.diagnostics.join("\n")).toMatch(/target lock busy/i);
    expect(existsSync(lockFile)).toBe(false);

    const acquired = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      tmux,
      now: () => startedAt + 35_012,
      attemptId: () => "attempt-after-stale-lock",
      send: async (_api, paneId) => {
        sends.push(paneId);
        return true;
      },
    });

    expect(acquired.attempts).toEqual([
      expect.objectContaining({
        attemptId: "attempt-after-stale-lock",
        outcome: "sent",
      }),
    ]);
    expect(sends).toEqual(["%2"]);
  });

  it("keeps a healthy target when another runtime config is corrupt", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    const corrupt = resolveTeamPaths(cwd, "corrupt");
    ensureTeamDirs(corrupt);
    writeFileSync(corrupt.configFile, '{"name":42}\n', "utf8");
    mkdirSync(
      path.join(path.dirname(resolveTeamPaths(cwd, "demo").teamRoot), "bad\\name"),
    );
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const result = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      tmux: readyTmux(cwd),
      now: () => startedAt + 10,
    });

    expect(result.targetsScanned).toBe(1);
    expect(result.diagnostics.join("\n")).toMatch(
      /runtime team corrupt: invalid team config/i,
    );
    expect(result.diagnostics.join("\n")).toMatch(
      /runtime team bad\\name: invalid team name/i,
    );
  });

  it("skips a runtime pane whose persisted tmux server fingerprint no longer matches", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const tmux = readyTmux(cwd, { serverPid: 9999 });
    const sends: string[] = [];
    const scan = (now: number) =>
      scanLoopTeamMonitorOnce(cwd, "owner-token", {
        tmux,
        now: () => now,
        send: async (_api, paneId) => {
          sends.push(paneId);
          return true;
        },
      });

    const first = await scan(startedAt + 10);
    const second = await scan(startedAt + 30_011);

    expect(first.targetsScanned).toBe(0);
    expect(second.targetsScanned).toBe(0);
    expect(sends).toEqual([]);
    expect(second.diagnostics.join("\n")).toMatch(/runtime team demo.*identity/i);
  });

  it("never reserves a fourth nudge after restart and keeps a failed transport slot consumed", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const tmux = readyTmux(cwd);
    const transportAttempts: string[] = [];
    let nextAttempt = 0;
    const scan = (offset: number) =>
      scanLoopTeamMonitorOnce(cwd, "owner-token", {
        tmux,
        now: () => startedAt + offset,
        attemptId: () => `attempt-${++nextAttempt}`,
        send: async (_api, paneId) => {
          transportAttempts.push(paneId);
          if (transportAttempts.length === 2) {
            throw new Error("simulated watcher crash during transport");
          }
          return true;
        },
      });

    await scan(10);
    const first = await scan(30_011);
    await scan(35_012);
    const second = await scan(65_013);
    await scan(70_014);
    const third = await scan(100_015);

    // A fresh scan dependency object simulates a restarted watcher hydrating
    // the durable target snapshot rather than retaining process memory.
    await scan(105_016);
    const afterRestart = await scan(135_017);

    expect([
      first.attempts[0]?.outcome,
      second.attempts[0]?.outcome,
      third.attempts[0]?.outcome,
    ]).toEqual(["sent", "failed", "sent"]);
    expect(afterRestart.attempts).toEqual([]);
    expect(transportAttempts).toEqual(["%2", "%2", "%2"]);

    const monitorPaths = resolveTeamMonitorPaths(cwd);
    const targetFile = readdirSync(monitorPaths.targetsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(monitorPaths.targetsDir, name))[0]!;
    const persisted = JSON.parse(readFileSync(targetFile, "utf8"));
    expect(persisted.tracker.panes[0]).toMatchObject({
      paneId: "%2",
      nudgeCount: 3,
      lastAttempt: { attemptId: "attempt-3", outcome: "sent" },
    });
  });

  it("keeps the global cap when a stale watcher is replaced during transport", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-old",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-old", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "old-build",
    });

    const tmux = readyTmux(cwd);
    await scanLoopTeamMonitorOnce(cwd, "owner-old", {
      tmux,
      now: () => startedAt + 10,
    });

    let signalOldEntered: () => void = () => undefined;
    let releaseOldTransport: () => void = () => undefined;
    const oldEntered = new Promise<void>((resolve) => {
      signalOldEntered = resolve;
    });
    const oldTransportBlocked = new Promise<void>((resolve) => {
      releaseOldTransport = resolve;
    });
    const transports: string[] = [];
    const oldScan = scanLoopTeamMonitorOnce(cwd, "owner-old", {
      tmux,
      now: () => startedAt + 30_011,
      attemptId: () => "attempt-old",
      send: async (_api, paneId) => {
        transports.push(`old:${paneId}`);
        signalOldEntered();
        await oldTransportBlocked;
        return true;
      },
    });
    await oldEntered;

    const replacement = ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt + 30_012,
      token: () => "owner-new",
    });
    expect(replacement).toMatchObject({ started: true, token: "owner-new" });
    expect(
      adoptLoopTeamMonitorOwner(cwd, "owner-new", {
        now: () => startedAt + 30_013,
        pid: 7002,
        buildId: "new-build",
      }),
    ).toEqual({ adopted: true });

    let nextAttempt = 1;
    const successorScan = (offset: number) =>
      scanLoopTeamMonitorOnce(cwd, "owner-new", {
        tmux,
        now: () => startedAt + offset,
        attemptId: () => `attempt-new-${++nextAttempt}`,
        send: async (_api, paneId) => {
          transports.push(`new:${paneId}`);
          return true;
        },
      });
    await successorScan(35_014);
    await successorScan(65_015);
    await successorScan(70_016);
    await successorScan(100_017);
    const afterCap = await successorScan(135_019);

    releaseOldTransport();
    const displaced = await oldScan;

    expect(displaced.attempts).toEqual([
      expect.objectContaining({
        attemptId: "attempt-old",
        nudgeCount: 1,
        outcome: "sent",
      }),
    ]);
    expect(afterCap.attempts).toEqual([]);
    expect(transports.sort()).toEqual(["new:%2", "new:%2", "old:%2"]);

    const paths = resolveTeamMonitorPaths(cwd);
    const targetFile = readdirSync(paths.targetsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(paths.targetsDir, name))[0]!;
    expect(JSON.parse(readFileSync(targetFile, "utf8")).tracker.panes[0]).toMatchObject({
      paneId: "%2",
      nudgeCount: 3,
      lastAttempt: {
        attemptId: "attempt-new-3",
        outcome: "sent",
      },
    });
  });

  it("consumes but does not send a reservation when shutdown wins the pre-send race", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const tmux = readyTmux(cwd);
    const basePaneContext = tmux.paneContext!;
    let contextReads = 0;
    tmux.paneContext = (paneId) => {
      contextReads += 1;
      if (contextReads === 5) {
        writeFileSync(
          resolveTeamPaths(cwd, "demo").shutdownFile,
          '{"shutdownAt":"2026-07-30T19:00:30.011Z"}\n',
          "utf8",
        );
      }
      return basePaneContext(paneId);
    };
    const sends: string[] = [];
    const deps = {
      tmux,
      attemptId: () => "attempt-1",
      send: async (_api: TmuxApi, paneId: string) => {
        sends.push(paneId);
        return true;
      },
    };

    await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      ...deps,
      now: () => startedAt + 10,
    });
    const result = await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      ...deps,
      now: () => startedAt + 30_011,
    });

    expect(result.attempts).toEqual([
      expect.objectContaining({ attemptId: "attempt-1", outcome: "skipped" }),
    ]);
    expect(sends).toEqual([]);
  });

  it("compacts terminal target state only after the 24 hour grace", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const paths = resolveTeamMonitorPaths(cwd);
    const staleFile = path.join(paths.targetsDir, "terminal-old.json");
    const freshFile = path.join(paths.targetsDir, "terminal-fresh.json");
    const targetState = (lastSeenAt: string) => ({
      schemaVersion: 1,
      targetId: "terminal",
      kind: "runtime",
      teamName: "finished",
      generation: "old",
      paneId: "%99",
      revision: 1,
      lastSeenAt,
      tracker: { schemaVersion: 1, lastScanAt: 0, panes: [] },
    });
    writeFileSync(
      staleFile,
      `${JSON.stringify(targetState(new Date(startedAt - 86_400_001).toISOString()))}\n`,
      "utf8",
    );
    writeFileSync(
      freshFile,
      `${JSON.stringify(targetState(new Date(startedAt - 86_399_999).toISOString()))}\n`,
      "utf8",
    );

    await scanLoopTeamMonitorOnce(cwd, "owner-token", {
      tmux: readyTmux(cwd),
      now: () => startedAt,
    });

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
  });
});

describe("runLoopTeamMonitor aggregate loop gate", () => {
  it("stays alive when one loop clears and exits after the final loop becomes inactive", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    writeModeStateJson(cwd, "ultrawork", { active: true });
    const now = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => now,
      token: () => "owner-token",
    });

    let scans = 0;
    const result = await runLoopTeamMonitor(cwd, "owner-token", {
      buildId: "test-build",
      now: () => now + scans,
      pid: 7001,
      scan: async () => {
        scans += 1;
        clearModeState(cwd, "ralph");
        return { targetsScanned: 1, attempts: [], diagnostics: [] };
      },
      sleep: async () => {
        writeModeStateJson(cwd, "ultrawork", { active: false });
      },
    });

    expect(result).toEqual({ ok: true, reason: "no-active-loop", scans: 1 });
    expect(scans).toBe(1);
    expect(existsSync(resolveTeamMonitorPaths(cwd).ownerFile)).toBe(false);
  });

  it("terminates and releases ownership when the final runtime team is shut down", async () => {
    const cwd = tempProject();
    writeRuntimeTeam(cwd);
    writeModeStateJson(cwd, "ralph", { active: true });
    const now = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => now,
      token: () => "owner-token",
    });
    writeFileSync(
      resolveTeamPaths(cwd, "demo").shutdownFile,
      `${JSON.stringify({ shutdownAt: new Date(now + 1).toISOString() })}\n`,
      "utf8",
    );

    const result = await runLoopTeamMonitor(cwd, "owner-token", {
      buildId: "test-build",
      now: () => now + 2,
      pid: 7001,
      scan: () =>
        scanLoopTeamMonitorOnce(cwd, "owner-token", {
          tmux: readyTmux(cwd),
          now: () => now + 2,
        }),
      sleep: async () => {
        throw new Error("must not sleep without a live target");
      },
    });

    expect(result).toEqual({
      ok: true,
      reason: "no-live-targets",
      scans: 1,
    });
    expect(existsSync(resolveTeamMonitorPaths(cwd).ownerFile)).toBe(false);
  });
});
