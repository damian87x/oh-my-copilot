import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const monitorMocks = vi.hoisted(() => ({
  ensureLoopTeamMonitor: vi.fn(),
  runLoopTeamMonitor: vi.fn(),
}));
const teamMocks = vi.hoisted(() => ({
  startTeam: vi.fn(),
  statusTeam: vi.fn(),
  formatStatus: vi.fn(),
}));
const visualMocks = vi.hoisted(() => ({
  registerVisualTeam: vi.fn(),
}));

vi.mock("../src/team/monitor-supervisor.js", () => ({
  ensureLoopTeamMonitor: monitorMocks.ensureLoopTeamMonitor,
  runLoopTeamMonitor: monitorMocks.runLoopTeamMonitor,
}));
vi.mock("../src/team/runtime.js", () => ({
  startTeam: teamMocks.startTeam,
  statusTeam: teamMocks.statusTeam,
  formatStatus: teamMocks.formatStatus,
}));
vi.mock("../src/team/visual-registration.js", () => ({
  registerVisualTeam: visualMocks.registerVisualTeam,
}));

import { runCli } from "../src/cli.js";

describe("loop command monitor activation", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "omc-cli-loop-monitor-"));
    writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf8");
    monitorMocks.ensureLoopTeamMonitor.mockReset();
    monitorMocks.ensureLoopTeamMonitor.mockReturnValue({
      started: false,
      reason: "no-live-targets",
    });
    monitorMocks.runLoopTeamMonitor.mockReset();
    monitorMocks.runLoopTeamMonitor.mockResolvedValue({
      ok: true,
      reason: "no-active-loop",
      scans: 1,
    });
    teamMocks.startTeam.mockReset();
    teamMocks.startTeam.mockResolvedValue({
      ok: true,
      tmuxSession: "omp-team-demo",
      config: {
        workers: [{ name: "worker-1", paneId: "%2" }],
      },
      paths: {},
    });
    teamMocks.statusTeam.mockReset();
    teamMocks.statusTeam.mockReturnValue({
      ok: true,
      config: { name: "demo" },
      snapshot: { tasks: [], workers: [], allDone: false },
    });
    teamMocks.formatStatus.mockReset();
    teamMocks.formatStatus.mockReturnValue("team demo");
    visualMocks.registerVisualTeam.mockReset();
    visualMocks.registerVisualTeam.mockReturnValue({
      ok: true,
      registration: {
        registrationId: "registration-1",
        generation: "generation-1",
      },
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    ["ralph", "ship the fix"],
    ["ultrawork", "ship the fix"],
    ["ultraqa", "verify the fix"],
  ])("%s start ensures the loop-team monitor after activating state", async (mode, objective) => {
    const result = await runCli([mode, "start", objective, "--root", cwd]);

    expect(result.ok).toBe(true);
    expect(monitorMocks.ensureLoopTeamMonitor).toHaveBeenCalledTimes(1);
    expect(monitorMocks.ensureLoopTeamMonitor).toHaveBeenCalledWith(cwd);
  });

  it("keeps loop start fail-open when monitor activation throws", async () => {
    monitorMocks.ensureLoopTeamMonitor.mockImplementationOnce(() => {
      throw new Error("spawn unavailable");
    });

    const result = await runCli(["ralph", "start", "ship the fix", "--root", cwd]);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/ralph started/);
  });

  it("ensures the monitor after a runtime team is created", async () => {
    const result = await runCli([
      "team",
      "1:copilot",
      "ship the fix",
      "--name",
      "demo",
      "--root",
      cwd,
    ]);

    expect(result.ok).toBe(true);
    expect(teamMocks.startTeam).toHaveBeenCalledTimes(1);
    expect(monitorMocks.ensureLoopTeamMonitor).toHaveBeenCalledWith(cwd);
  });

  it("runs the hidden monitor child with an absolute root, token, and build identity", async () => {
    const result = await runCli([
      "team",
      "monitor-loop",
      "--root",
      cwd,
      "--token",
      "owner-token",
      "--json",
    ]);

    expect(result.ok).toBe(true);
    expect(monitorMocks.runLoopTeamMonitor).toHaveBeenCalledWith(
      cwd,
      "owner-token",
      expect.objectContaining({ buildId: expect.stringMatching(/^0\.31\.0:/) }),
    );
    const help = await runCli(["help"]);
    expect(help.message).not.toContain("monitor-loop");
  });

  it("passes strict visual registration metadata through the hidden command", async () => {
    const result = await runCli([
      "team",
      "register-visual",
      "--root",
      cwd,
      "--name",
      "visual-demo",
      "--launch-id",
      "launch-1",
      "--dir",
      "/tmp/team-visual-demo",
      "--manifest",
      "/tmp/team-visual-demo/manifest.json",
      "--socket",
      "/tmp/team.sock",
      "--server-pid",
      "66728",
      "--server-start-time",
      "1785439051",
      "--session-id",
      "$4",
      "--session-created",
      "1785439000",
      "--window-id",
      "@8",
      "--json",
    ]);

    expect(result.ok).toBe(true);
    expect(visualMocks.registerVisualTeam).toHaveBeenCalledWith({
      cwd,
      teamName: "visual-demo",
      launchId: "launch-1",
      deliveryDir: "/tmp/team-visual-demo",
      manifestPath: "/tmp/team-visual-demo/manifest.json",
      socketPath: "/tmp/team.sock",
      serverPid: 66728,
      serverStartedAt: 1785439051,
      sessionId: "$4",
      sessionCreatedAt: 1785439000,
      windowId: "@8",
    });
    const help = await runCli(["help"]);
    expect(help.message).not.toContain("register-visual");
  });

  it("keeps team status read-only and never ensures the watcher", async () => {
    const monitorDir = path.join(cwd, ".omp", "state", "team-monitor");
    const sentinel = path.join(monitorDir, "status.json");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(sentinel, '{"sentinel":true}\n', "utf8");
    const before = {
      content: readFileSync(sentinel, "utf8"),
      mtimeNs: statSync(sentinel, { bigint: true }).mtimeNs,
    };

    const result = await runCli([
      "team",
      "status",
      "demo",
      "--root",
      cwd,
    ]);

    expect(result.ok).toBe(true);
    expect(teamMocks.statusTeam).toHaveBeenCalledWith({
      cwd,
      name: "demo",
    });
    expect(monitorMocks.ensureLoopTeamMonitor).not.toHaveBeenCalled();
    expect(readFileSync(sentinel, "utf8")).toBe(before.content);
    expect(statSync(sentinel, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
  });

  it("keeps team collect and its delivery files read-only", async () => {
    const deliveryDir = mkdtempSync(path.join(tmpdir(), "omc-cli-collect-"));
    const manifest = path.join(deliveryDir, "manifest.json");
    const resultFile = path.join(deliveryDir, "lane-a.result.md");
    writeFileSync(
      manifest,
      `${JSON.stringify([{ id: "lane-a", name: "Lane A" }])}\n`,
      "utf8",
    );
    writeFileSync(resultFile, "complete\n", "utf8");
    const before = [manifest, resultFile].map((file) => ({
      file,
      content: readFileSync(file, "utf8"),
      mtimeNs: statSync(file, { bigint: true }).mtimeNs,
    }));
    try {
      const result = await runCli([
        "team",
        "collect",
        "--dir",
        deliveryDir,
        "--root",
        cwd,
        "--json",
      ]);

      expect(result.ok).toBe(true);
      expect(monitorMocks.ensureLoopTeamMonitor).not.toHaveBeenCalled();
      for (const snapshot of before) {
        expect(readFileSync(snapshot.file, "utf8")).toBe(snapshot.content);
        expect(statSync(snapshot.file, { bigint: true }).mtimeNs).toBe(
          snapshot.mtimeNs,
        );
      }
    } finally {
      rmSync(deliveryDir, { recursive: true, force: true });
    }
  });
});
