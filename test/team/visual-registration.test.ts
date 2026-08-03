import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  registerVisualTeam,
  type VisualRegistrationInput,
} from "../../src/team/visual-registration.js";
import { writeModeStateJson } from "../../src/mode-state/paths.js";
import {
  adoptLoopTeamMonitorOwner,
  ensureLoopTeamMonitor,
  runLoopTeamMonitor,
  type MonitorSpawn,
} from "../../src/team/monitor-supervisor.js";
import { scanLoopTeamMonitorOnce } from "../../src/team/loop-monitor.js";
import {
  ensureTeamDirs,
  resolveTeamMonitorPaths,
  resolveTeamPaths,
} from "../../src/team/state-paths.js";
import type { TeamConfig } from "../../src/team/types.js";
import type {
  TmuxApi,
  TmuxPaneContext,
  TmuxResult,
} from "../../src/team/tmux.js";

function ok(stdout = ""): TmuxResult {
  return { stdout, stderr: "", status: 0 };
}

function visualTmux(context: TmuxPaneContext): TmuxApi {
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
    listSessions: () => ["visual-demo"],
    paneContext: () => context,
  };
}

function fixture(): {
  cwd: string;
  input: VisualRegistrationInput;
  context: TmuxPaneContext;
} {
  const cwd = mkdtempSync(path.join(tmpdir(), "omc-visual-project-"));
  writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf8");
  const deliveryDir = mkdtempSync(path.join(tmpdir(), "team-visual-demo-"));
  const manifestPath = path.join(deliveryDir, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify([{ id: "lane-a", name: "Lane A", paneId: "%7" }], null, 2)}\n`,
    "utf8",
  );
  const context: TmuxPaneContext = {
    socketPath: "/tmp/team.sock",
    serverPid: 66728,
    serverStartedAt: 1785439051,
    sessionId: "$4",
    sessionCreatedAt: 1785439000,
    windowId: "@8",
    paneId: "%7",
    currentPath: cwd,
    dead: false,
    launchId: "launch-1",
    laneId: "lane-a",
  };
  return {
    cwd,
    context,
    input: {
      cwd,
      teamName: "visual-demo",
      launchId: "launch-1",
      deliveryDir,
      manifestPath,
      socketPath: context.socketPath,
      serverPid: context.serverPid,
      serverStartedAt: context.serverStartedAt,
      sessionId: context.sessionId,
      sessionCreatedAt: context.sessionCreatedAt,
      windowId: context.windowId,
    },
  };
}

function writeRuntimeTeam(cwd: string, name: string, paneId: string): void {
  const paths = resolveTeamPaths(cwd, name);
  ensureTeamDirs(paths);
  const config: TeamConfig = {
    name,
    task: "ship issue 110",
    role: "copilot",
    workerCount: 1,
    tmuxSession: `omp-team-${name}`,
    tmuxIdentity: {
      socketPath: "/tmp/runtime-team.sock",
      serverPid: 7311,
      serverStartedAt: 1785430000,
      sessionId: "$1",
      sessionCreatedAt: 1785430001,
      windowId: "@1",
    },
    workers: [{ name: "worker-1", paneId, taskId: "1" }],
    cwd,
    createdAt: `2026-07-30T18:00:0${paneId.slice(1)}.000Z`,
  };
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function runtimeTmux(cwd: string): TmuxApi {
  return {
    ...visualTmux({
      socketPath: "/tmp/runtime-team.sock",
      serverPid: 7311,
      serverStartedAt: 1785430000,
      sessionId: "$1",
      sessionCreatedAt: 1785430001,
      windowId: "@1",
      paneId: "%2",
      currentPath: cwd,
      dead: false,
      launchId: "",
      laneId: "",
    }),
    listSessions: () => ["omp-team-runtime-a", "omp-team-runtime-b"],
    paneContext: (paneId) => ({
      socketPath: "/tmp/runtime-team.sock",
      serverPid: 7311,
      serverStartedAt: 1785430000,
      sessionId: "$1",
      sessionCreatedAt: 1785430001,
      windowId: "@1",
      paneId,
      currentPath: cwd,
      dead: false,
      launchId: "",
      laneId: "",
    }),
  };
}

function snapshotDeliveryDirectory(dir: string): unknown {
  return {
    directoryMtimeNs: statSync(dir, { bigint: true }).mtimeNs.toString(),
    files: readdirSync(dir)
      .sort()
      .map((name) => {
        const file = path.join(dir, name);
        const stat = statSync(file, { bigint: true });
        const content = readFileSync(file);
        return {
          name,
          mtimeNs: stat.mtimeNs.toString(),
          size: stat.size.toString(),
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      }),
  };
}

describe("registerVisualTeam", () => {
  it("accepts the launcher's canonical /tmp delivery directory on macOS", () => {
    const { input, context } = fixture();
    const deliveryDir = mkdtempSync("/tmp/team-visual-launcher-");
    const manifestPath = path.join(deliveryDir, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify([
        { id: "lane-a", name: "Lane A", paneId: "%7" },
      ])}\n`,
      "utf8",
    );
    try {
      const result = registerVisualTeam(
        { ...input, deliveryDir, manifestPath },
        {
          tmuxForSocket: () => visualTmux(context),
          ensure: () => ({ started: false, reason: "no-active-loop" }),
        },
      );
      expect(result).toMatchObject({ ok: true });
    } finally {
      rmSync(deliveryDir, { recursive: true, force: true });
    }
  });

  it("persists one validated pointer and preserves generation on re-registration", () => {
    const { cwd, input, context } = fixture();
    const ensure = vi.fn(() => ({ started: false, reason: "no-active-loop" as const }));
    const deps = {
      tmuxForSocket: () => visualTmux(context),
      ensure,
      now: () => Date.parse("2026-07-30T19:00:00.000Z"),
    };

    const first = registerVisualTeam(input, deps);
    const second = registerVisualTeam(input, deps);

    if (!first.ok) throw new Error(first.error);
    if (!second.ok) throw new Error(second.error);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(second.registration.generation).toBe(first.registration.generation);

    const paths = resolveTeamMonitorPaths(cwd);
    const registrations = readdirSync(paths.visualDir).filter((name) =>
      name.endsWith(".json"),
    );
    expect(registrations).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(path.join(paths.visualDir, registrations[0]!), "utf8"),
      ),
    ).toMatchObject({
      teamName: "visual-demo",
      launchId: "launch-1",
      generation: first.registration.generation,
      panes: [{ paneId: "%7", laneId: "lane-a" }],
    });
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("assigns a different generation to a genuinely new launch", () => {
    const { input, context } = fixture();
    let activeContext = context;
    const tmux = visualTmux(context);
    tmux.paneContext = () => activeContext;
    const deps = {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "no-active-loop" as const }),
    };

    const first = registerVisualTeam(input, deps);
    activeContext = { ...context, launchId: "launch-2" };
    const second = registerVisualTeam(
      { ...input, launchId: "launch-2" },
      deps,
    );

    if (!first.ok) throw new Error(first.error);
    if (!second.ok) throw new Error(second.error);
    expect(second.registration.generation).not.toBe(first.registration.generation);
    expect(second.registration.registrationId).not.toBe(
      first.registration.registrationId,
    );
  });

  it.each([
    ["wrong server pid", { serverPid: 99999 }],
    ["wrong server start time", { serverStartedAt: 1785439999 }],
    ["wrong session", { sessionId: "$99" }],
    ["wrong session creation time", { sessionCreatedAt: 1785439999 }],
    ["wrong window", { windowId: "@99" }],
    ["wrong launch tag", { launchId: "other-launch" }],
    ["wrong lane tag", { laneId: "other-lane" }],
    ["dead pane", { dead: true }],
  ])("rejects a live-looking pane with %s", (_label, override) => {
    const { input, context } = fixture();
    const result = registerVisualTeam(input, {
      tmuxForSocket: () => visualTmux({ ...context, ...override }),
      ensure: () => ({ started: false, reason: "no-active-loop" }),
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a pane whose canonical cwd is outside the project root", () => {
    const { input, context } = fixture();
    const result = registerVisualTeam(input, {
      tmuxForSocket: () =>
        visualTmux({ ...context, currentPath: path.dirname(input.cwd) }),
      ensure: () => ({ started: false, reason: "no-active-loop" }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/outside the project root/i),
    });
  });

  it("rejects a symlinked manifest", () => {
    const { input, context } = fixture();
    const otherDir = mkdtempSync(path.join(tmpdir(), "team-visual-link-"));
    const realManifest = path.join(otherDir, "real-manifest.json");
    writeFileSync(
      realManifest,
      `${JSON.stringify([{ id: "lane-a", paneId: "%7" }])}\n`,
      "utf8",
    );
    const linkedDir = mkdtempSync(path.join(tmpdir(), "team-visual-linked-"));
    const linkedManifest = path.join(linkedDir, "manifest.json");
    symlinkSync(realManifest, linkedManifest);
    try {
      const result = registerVisualTeam(
        {
          ...input,
          deliveryDir: linkedDir,
          manifestPath: linkedManifest,
        },
        {
          tmuxForSocket: () => visualTmux(context),
          ensure: () => ({ started: false, reason: "no-active-loop" }),
        },
      );
      expect(result).toMatchObject({ ok: false });
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("rejects a manifest outside the system temporary root", () => {
    const { input, context } = fixture();
    const outsideDir = mkdtempSync(
      path.join(process.cwd(), ".omc-visual-outside-"),
    );
    const outsideManifest = path.join(outsideDir, "manifest.json");
    writeFileSync(
      outsideManifest,
      `${JSON.stringify([{ id: "lane-a", paneId: "%7" }])}\n`,
      "utf8",
    );
    try {
      const result = registerVisualTeam(
        {
          ...input,
          deliveryDir: outsideDir,
          manifestPath: outsideManifest,
        },
        {
          tmuxForSocket: () => visualTmux(context),
          ensure: () => ({ started: false, reason: "no-active-loop" }),
        },
      );
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/system temp root/i),
      });
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("makes a visual-only target reachable when a loop is already active", () => {
    const { cwd, input, context } = fixture();
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => visualTmux(context),
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    let spawnCount = 0;
    const spawn: MonitorSpawn = () => {
      spawnCount += 1;
      return { on: () => undefined, unref: () => undefined };
    };
    const result = ensureLoopTeamMonitor(cwd, {
      spawn,
      cliPath: "/pkg/dist/src/cli.js",
      token: () => "visual-owner",
    });

    expect(result).toMatchObject({ started: true, token: "visual-owner" });
    expect(spawnCount).toBe(1);
  });

  it("discovers and nudges a validated visual pane through its recorded socket", async () => {
    const { cwd, input, context } = fixture();
    const tmux = visualTmux(context);
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "visual-owner",
    });
    adoptLoopTeamMonitorOwner(cwd, "visual-owner", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const sends: string[] = [];
    const deps = {
      tmuxForSocket: () => tmux,
      attemptId: () => "visual-attempt",
      send: async (_tmux: TmuxApi, paneId: string) => {
        sends.push(paneId);
        return true;
      },
    };
    const first = await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      ...deps,
      now: () => startedAt + 10,
    });
    const second = await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      ...deps,
      now: () => startedAt + 30_011,
    });

    expect(first.targetsScanned).toBe(1);
    expect(second.attempts).toHaveLength(1);
    expect(sends).toEqual(["%7"]);
  });

  it("tracks two runtime teams and one visual team independently", async () => {
    const { cwd, input, context } = fixture();
    const visualApi = visualTmux(context);
    const runtimeApi = runtimeTmux(cwd);
    writeRuntimeTeam(cwd, "runtime-a", "%2");
    writeRuntimeTeam(cwd, "runtime-b", "%3");
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => visualApi,
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "mixed-owner",
    });
    adoptLoopTeamMonitorOwner(cwd, "mixed-owner", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    const sends: string[] = [];
    let attempt = 0;
    const deps = {
      tmuxForSocket: (socketPath: string) =>
        socketPath === "/tmp/runtime-team.sock" ? runtimeApi : visualApi,
      attemptId: () => `mixed-attempt-${++attempt}`,
      send: async (_tmux: TmuxApi, paneId: string) => {
        sends.push(paneId);
        return true;
      },
    };
    const first = await scanLoopTeamMonitorOnce(cwd, "mixed-owner", {
      ...deps,
      now: () => startedAt + 10,
    });
    const second = await scanLoopTeamMonitorOnce(cwd, "mixed-owner", {
      ...deps,
      now: () => startedAt + 30_011,
    });

    expect(first.targetsScanned).toBe(3);
    expect(second.targetsScanned).toBe(3);
    expect(second.attempts).toHaveLength(3);
    expect(sends.sort()).toEqual(["%2", "%3", "%7"]);
    expect(
      readdirSync(resolveTeamMonitorPaths(cwd).targetsDir).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(3);
  });

  it("exits when the final visual lane delivers its result", async () => {
    const { cwd, input, context } = fixture();
    const tmux = visualTmux(context);
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "visual-owner",
    });
    writeFileSync(
      path.join(input.deliveryDir, "lane-a.result.md"),
      "completed\n",
      "utf8",
    );
    const sends: string[] = [];

    const result = await runLoopTeamMonitor(cwd, "visual-owner", {
      buildId: "test-build",
      now: () => startedAt + 2,
      pid: 7001,
      scan: () =>
        scanLoopTeamMonitorOnce(cwd, "visual-owner", {
          tmuxForSocket: () => tmux,
          now: () => startedAt + 2,
          send: async (_api, paneId) => {
            sends.push(paneId);
            return true;
          },
        }),
      sleep: async () => {
        throw new Error("must not sleep without a live visual target");
      },
    });

    expect(result).toEqual({
      ok: true,
      reason: "no-live-targets",
      scans: 1,
    });
    expect(sends).toEqual([]);
    expect(existsSync(resolveTeamMonitorPaths(cwd).ownerFile)).toBe(false);
  });

  it("preserves a live launch generation and its persisted nudge count when re-registered", async () => {
    const { cwd, input, context } = fixture();
    const tmux = visualTmux(context);
    writeModeStateJson(cwd, "ralph", { active: true });
    const firstRegistration = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-pending" }),
      now: () => Date.parse("2026-07-30T19:00:00.000Z"),
    });
    if (!firstRegistration.ok) throw new Error(firstRegistration.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "visual-owner",
    });
    adoptLoopTeamMonitorOwner(cwd, "visual-owner", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });
    await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      tmuxForSocket: () => tmux,
      now: () => startedAt + 10,
    });
    await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      tmuxForSocket: () => tmux,
      now: () => startedAt + 30_011,
      attemptId: () => "visual-attempt",
      send: async () => true,
    });

    const secondRegistration = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-running" }),
      now: () => startedAt + 31_000,
    });
    if (!secondRegistration.ok) throw new Error(secondRegistration.error);
    expect(secondRegistration.registration.generation).toBe(
      firstRegistration.registration.generation,
    );

    const paths = resolveTeamMonitorPaths(cwd);
    const targetFiles = readdirSync(paths.targetsDir).filter((name) =>
      name.endsWith(".json"),
    );
    expect(targetFiles).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(path.join(paths.targetsDir, targetFiles[0]!), "utf8"),
      ),
    ).toMatchObject({
      generation: firstRegistration.registration.generation,
      tracker: {
        panes: [
          {
            paneId: "%7",
            nudgeCount: 1,
            lastAttempt: {
              attemptId: "visual-attempt",
              outcome: "sent",
            },
          },
        ],
      },
    });
  });

  it("does not send to recycled pane ids after the tmux server fingerprint or tags change", async () => {
    const { cwd, input, context } = fixture();
    let activeContext = context;
    const tmux = visualTmux(context);
    tmux.paneContext = () => activeContext;
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "visual-owner",
    });
    adoptLoopTeamMonitorOwner(cwd, "visual-owner", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });

    activeContext = {
      ...context,
      serverPid: context.serverPid + 1,
      serverStartedAt: context.serverStartedAt + 1,
      launchId: "recycled-launch",
    };
    const sends: string[] = [];
    const result = await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      tmuxForSocket: () => tmux,
      now: () => startedAt + 30_011,
      send: async (_api, paneId) => {
        sends.push(paneId);
        return true;
      },
    });

    expect(result.targetsScanned).toBe(0);
    expect(result.attempts).toEqual([]);
    expect(sends).toEqual([]);
    expect(result.diagnostics.join("\n")).toMatch(/identity or lane state is not live/i);
  });

  it("leaves the visual delivery directory byte-for-byte and mtime unchanged during scans", async () => {
    const { cwd, input, context } = fixture();
    const tmux = visualTmux(context);
    writeFileSync(
      path.join(input.deliveryDir, "operator-note.txt"),
      "must remain untouched\n",
      "utf8",
    );
    writeModeStateJson(cwd, "ralph", { active: true });
    const registered = registerVisualTeam(input, {
      tmuxForSocket: () => tmux,
      ensure: () => ({ started: false, reason: "already-pending" }),
    });
    if (!registered.ok) throw new Error(registered.error);

    const startedAt = Date.parse("2026-07-30T19:00:00.000Z");
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      now: () => startedAt,
      token: () => "visual-owner",
    });
    adoptLoopTeamMonitorOwner(cwd, "visual-owner", {
      now: () => startedAt + 1,
      pid: 7001,
      buildId: "test-build",
    });
    const before = snapshotDeliveryDirectory(input.deliveryDir);

    await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      tmuxForSocket: () => tmux,
      now: () => startedAt + 10,
    });
    await scanLoopTeamMonitorOnce(cwd, "visual-owner", {
      tmuxForSocket: () => tmux,
      now: () => startedAt + 30_011,
      send: async () => true,
    });

    expect(snapshotDeliveryDirectory(input.deliveryDir)).toEqual(before);
  });
});
