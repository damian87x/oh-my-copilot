import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as tmuxModule from "../../src/team/tmux.js";
import { apiSendMessage } from "../../src/team/api.js";
import { collectDeliveries, readManifest } from "../../src/team/collect.js";
import { hcGroupName, makeHerdr } from "../../src/team/herdr.js";
import { formatStatus, shutdownTeam, startTeam, statusTeam } from "../../src/team/runtime.js";
import { monitorPanes } from "../../src/team/pane-monitor.js";
import { resolveTeamPaths } from "../../src/team/state-paths.js";
import type { TmuxApi } from "../../src/team/tmux.js";
import type { TeamConfig } from "../../src/team/types.js";
import { makeFakeHc } from "./fake-hc.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-runtime-herdr-"));
  dirs.push(cwd);
  writeFileSync(path.join(cwd, "package.json"), "{}\n");
  const bin = path.join(cwd, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "copilot"), 0o755);
  const fake = makeFakeHc();
  const herdr = makeHerdr({ runner: fake.runner, env: { PATH: bin }, envDir: path.join(cwd, "hc-env") });
  return { cwd, fake, herdr };
}

/** A tmux client that fails the test if anything touches it. */
const forbiddenTmux = new Proxy({} as TmuxApi, {
  get(_t, prop) {
    return () => {
      throw new Error(`tmux.${String(prop)} must not be called for a herdr team`);
    };
  },
});

describe("omp team on herdr", () => {
  it("start: one hc terminal per worker, prompts sent, backend pinned in config", async () => {
    const { cwd, fake, herdr } = setup();
    const result = await startTeam({ cwd, name: "x", role: "copilot", workerCount: 2, task: "fix it", herdr, tmux: forbiddenTmux });
    const group = hcGroupName("x", cwd);
    expect(result.config.mux).toEqual({ kind: "herdr", group });
    expect(result.config.workers.map((w) => w.paneId)).toEqual(["t1", "t2"]);
    expect([...fake.terminals.values()].map((t) => t.name)).toEqual([`${group}-w1`, `${group}-w2`]);
    const runs = fake.calls.filter((c) => c[0] === "run");
    expect(runs[0]).toEqual(expect.arrayContaining(["--label", "omp.team=x", "--no-parent"]));
    expect(runs[0]!.slice(-1)[0]).toBe("--allow-all-tools");
    expect(fake.sends.map((s) => s.target)).toEqual(["t1", "t2"]);
    expect(fake.sends[0]!.text).toMatch(/Read your inbox at .*worker-1\/inbox\.md.*fix it \(part 1\/2\)/);
    const saved = JSON.parse(readFileSync(resolveTeamPaths(cwd, "x").configFile, "utf8")) as TeamConfig;
    expect(saved.mux?.kind).toBe("herdr");
  });

  it("refuses to start twice while the group's terminals are live", async () => {
    const { cwd, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr });
    await expect(startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr })).rejects.toThrow(/already exist/);
  });

  it("rejects readiness timeout without sending a task", async () => {
    const { cwd, fake, herdr } = setup();
    vi.spyOn(tmuxModule, "waitForReady").mockResolvedValue(false);
    await expect(startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr }))
      .rejects.toThrow(/did not become ready/);
    expect(fake.sends).toEqual([]);
    expect(fake.terminals.size).toBe(0);
  });

  it("rejects failed task delivery and cleans up without retrying", async () => {
    const { cwd, fake, herdr } = setup();
    herdr.submit = async () => false;
    await expect(startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr }))
      .rejects.toThrow(/deliver/);
    expect(fake.terminals.size).toBe(0);
  });

  it("isolates same-named teams and config-less shutdown across projects", async () => {
    const a = setup();
    const b = setup();
    await startTeam({ cwd: a.cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr: a.herdr });
    const noopTmux = { sessionExists: () => false } as unknown as TmuxApi;
    await shutdownTeam({ cwd: b.cwd, name: "x", tmux: noopTmux, herdr: a.herdr });
    expect(a.fake.terminals.size).toBe(1);
    await startTeam({ cwd: b.cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr: a.herdr });
    expect(a.fake.terminals.size).toBe(2);
    await shutdownTeam({ cwd: b.cwd, name: "x", tmux: noopTmux, herdr: a.herdr });
    expect(a.fake.terminals.size).toBe(1);
  });

  it("a failed spawn leaves no live terminals behind", async () => {
    const { cwd, fake, herdr } = setup();
    await expect(
      startTeam({ cwd, name: "x", role: "copilot", workerCount: 2, task: "t", herdr, workerBinOverride: "copilot-missing" }),
    ).rejects.toThrow(/not found/);
    expect([...fake.terminals.values()].filter((t) => t.state === "live")).toHaveLength(0);
  });

  it("status and shutdown use the pinned backend, never tmux", async () => {
    const { cwd, fake, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 2, task: "t", herdr });
    const report = statusTeam({ cwd, name: "x", tmux: forbiddenTmux, herdr });
    expect(report.snapshot?.workers.map((w) => w.paneDead)).toEqual([false, false]);
    expect(formatStatus(report)).toMatch(/backend herdr .*monitor: unavailable on herdr/);

    const down = await shutdownTeam({ cwd, name: "x", tmux: forbiddenTmux, herdr });
    expect(down).toMatchObject({ ok: true, killedPanes: 2, killedSession: true });
    expect(fake.terminals.size).toBe(0);
  });

  it("core down ⇒ workers reported alive-unknown, not dead", async () => {
    const { cwd, fake, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr });
    fake.down = true;
    expect(statusTeam({ cwd, name: "x", herdr }).snapshot?.workers[0]!.paneDead).toBe(false);
  });

  it("config-less shutdown sweeps the deterministic hc group", async () => {
    const { cwd, fake, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 2, task: "t", herdr });
    rmSync(resolveTeamPaths(cwd, "x").configFile);
    const noopTmux = { sessionExists: () => false } as unknown as TmuxApi;
    const down = await shutdownTeam({ cwd, name: "x", tmux: noopTmux, herdr });
    expect(down).toMatchObject({ ok: true, killedPanes: 2 });
    expect(fake.terminals.size).toBe(0);
  });

  it("send-message nudges via herdr even when the caller's env/injected client is tmux", async () => {
    const { cwd, fake, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr });
    fake.sends.length = 0;
    const r = await apiSendMessage({ team_name: "x", from: "leader-fixed", to: "worker-1", body: "hi", cwd }, forbiddenTmux, herdr);
    expect(r).toMatchObject({ ok: true, nudged: true });
    expect(fake.sends[0]).toMatchObject({ target: "t1", text: expect.stringMatching(/new message/) });
  });

  it("legacy configs without mux stay on tmux", async () => {
    const { cwd } = setup();
    const paths = resolveTeamPaths(cwd, "legacy");
    mkdirSync(paths.teamRoot, { recursive: true });
    const config: TeamConfig = {
      name: "legacy", task: "t", role: "copilot", workerCount: 1, tmuxSession: "omp-team-legacy",
      workers: [{ name: "worker-1", role: "copilot", paneId: "%3", taskId: "1" }], cwd, createdAt: "2026-01-01T00:00:00Z",
    };
    writeFileSync(paths.configFile, JSON.stringify(config));
    const seen: string[] = [];
    const tmux = { paneDead: (p: string) => (seen.push(p), false) } as unknown as TmuxApi;
    statusTeam({ cwd, name: "legacy", tmux, herdr: forbiddenTmux });
    expect(seen).toEqual(["%3"]);
  });
});

describe("collect on herdr manifests", () => {
  function dir(lanes: unknown) {
    const d = mkdtempSync(path.join(tmpdir(), "omp-collect-herdr-"));
    dirs.push(d);
    writeFileSync(path.join(d, "manifest.json"), JSON.stringify(lanes));
    return d;
  }

  it("accepts hc addresses when lanes say mux herdr and pins liveness to herdr", () => {
    const d = dir([
      { id: "a", name: "A", paneId: "t1", mux: "herdr" },
      { id: "b", name: "B", paneId: "t2", mux: "herdr" },
    ]);
    const lanes = readManifest(d);
    expect(lanes).toHaveLength(2);
    writeFileSync(path.join(d, "a.result.md"), "done A");
    const herdr = { paneDead: (p: string) => p === "t2" } as unknown as TmuxApi;
    const r = collectDeliveries(d, lanes, { tmux: forbiddenTmux, herdr });
    expect(r.lanes.map((l) => l.status)).toEqual(["done", "dead"]);
    expect(r.allDone).toBe(true);
  });

  it("rejects hc addresses without mux, and mixed-backend manifests", () => {
    expect(readManifest(dir([{ id: "a", paneId: "t1" }]))).toEqual([]);
    expect(readManifest(dir([{ id: "a", paneId: "%1" }, { id: "b", paneId: "t2", mux: "herdr" }]))).toEqual([]);
    expect(readManifest(dir([{ id: "a", paneId: "%1", mux: "herdr" }]))).toEqual([]);
  });

  it("legacy %N manifests are unchanged", () => {
    expect(readManifest(dir([{ id: "a", paneId: "%1" }, { id: "b", paneId: "%2", mux: "tmux" }]))).toHaveLength(2);
  });
});

describe("monitor-panes on herdr", () => {
  it("reports readiness through herdr submit, never tmux display-message", async () => {
    const { fake, herdr } = setup();
    fake.terminals.set("t1", { name: "lead", state: "live" });
    fake.terminals.set("t2", { name: "w", state: "finished" });
    const result = await monitorPanes({
      leaderPaneId: "t1",
      workerPaneIds: ["t2"],
      mux: "herdr",
      herdr,
      tmux: forbiddenTmux,
      config: { pollIntervalMs: 1, timeoutMs: 1000 },
    });
    expect(result.ok).toBe(true);
    expect(result.events[0]?.kind).toBe("dead");
    expect(fake.sends[0]?.target).toBe("t1");
  });
});

describe("loop monitor and CLI on herdr teams", () => {
  it("loop monitor skips herdr teams without an 'invalid team config' diagnostic", async () => {
    const { cwd, herdr } = setup();
    await startTeam({ cwd, name: "x", role: "copilot", workerCount: 1, task: "t", herdr });
    const { writeModeStateJson } = await import("../../src/mode-state/paths.js");
    const { ensureLoopTeamMonitor, adoptLoopTeamMonitorOwner } = await import("../../src/team/monitor-supervisor.js");
    const { scanLoopTeamMonitorOnce } = await import("../../src/team/loop-monitor.js");
    // A live tmux team makes the supervisor start, so the scan really walks team configs.
    const legacy = resolveTeamPaths(cwd, "legacy");
    mkdirSync(legacy.teamRoot, { recursive: true });
    writeFileSync(legacy.configFile, JSON.stringify({
      name: "legacy", task: "t", role: "copilot", workerCount: 1, tmuxSession: "omp-team-legacy",
      tmuxIdentity: { socketPath: "/tmp/omp.sock", serverPid: 1, serverStartedAt: 1, sessionId: "$1", sessionCreatedAt: 1, windowId: "@1" },
      workers: [{ name: "worker-1", paneId: "%2", taskId: "1" }], cwd, createdAt: "2026-01-01T00:00:00Z",
    }));
    writeModeStateJson(cwd, "ralph", { active: true });
    ensureLoopTeamMonitor(cwd, {
      spawn: () => ({ on: () => undefined, unref: () => undefined }),
      cliPath: "/pkg/dist/src/cli.js",
      token: () => "owner-token",
    });
    adoptLoopTeamMonitorOwner(cwd, "owner-token", { pid: 7001, buildId: "test-build" });
    const tmux = { sessionExists: () => false } as unknown as TmuxApi;
    const scan = await scanLoopTeamMonitorOnce(cwd, "owner-token", { tmux });
    expect(scan.diagnostics.filter((d) => d.includes("runtime team x"))).toEqual([]);
  });

  it("monitor-panes rejects mixed pane ids and a bad --mux", async () => {
    const { runCli } = await import("../../src/cli.js");
    const mixed = await runCli(["team", "monitor-panes", "--leader-pane", "%1", "--worker-pane", "t2"]);
    expect(mixed).toMatchObject({ ok: false, message: expect.stringMatching(/mix tmux/) });
    const bad = await runCli(["team", "monitor-panes", "--leader-pane", "t1", "--worker-pane", "t2", "--mux", "screen"]);
    expect(bad).toMatchObject({ ok: false, message: expect.stringMatching(/--mux must be herdr or tmux/) });
  });
});
