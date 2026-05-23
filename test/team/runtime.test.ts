import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatStatus,
  loadTeamConfig,
  monitorTeam,
  pollSnapshot,
  resolveWorkerBin,
  shutdownTeam,
  startTeam,
  statusTeam,
} from "../../src/team/runtime.js";
import { resolveTeamPaths, resolveWorkerPaths } from "../../src/team/state-paths.js";
import { writeTask, taskFilePath } from "../../src/team/task-store.js";
import { apiClaimTask, apiTransitionTaskStatus } from "../../src/team/api.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";
import type { TeamConfig } from "../../src/team/types.js";

function tempCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "omc-runtime-"));
}

function mockTmux(): { api: TmuxApi; calls: string[][]; deadPanes: Set<string> } {
  const calls: string[][] = [];
  const deadPanes = new Set<string>();
  let paneCounter = 0;
  const api: TmuxApi = {
    newSession(session) {
      calls.push(["new-session", session]);
      return { stdout: `${session}:0 %${++paneCounter}`, stderr: "", status: 0 } satisfies TmuxResult;
    },
    splitWindow() {
      calls.push(["split-window"]);
      return { stdout: `%${++paneCounter}\n`, stderr: "", status: 0 } satisfies TmuxResult;
    },
    sendKeys(target, ...keys) {
      calls.push(["send-keys", target, ...keys]);
      return { stdout: "", stderr: "", status: 0 } satisfies TmuxResult;
    },
    sendText(target, text) {
      calls.push(["send-text", target, text]);
      return { stdout: "", stderr: "", status: 0 } satisfies TmuxResult;
    },
    capturePane(target) {
      calls.push(["capture-pane", target]);
      return { stdout: "$ ", stderr: "", status: 0 } satisfies TmuxResult;
    },
    killPane(target) {
      calls.push(["kill-pane", target]);
      return { stdout: "", stderr: "", status: 0 } satisfies TmuxResult;
    },
    killSession(target) {
      calls.push(["kill-session", target]);
      return { stdout: "", stderr: "", status: 0 } satisfies TmuxResult;
    },
    paneDead(target) {
      return deadPanes.has(target);
    },
    sessionExists() {
      return false;
    },
  };
  return { api, calls, deadPanes };
}

describe("resolveWorkerBin", () => {
  it("maps known roles to CLI binaries", () => {
    expect(resolveWorkerBin("claude")).toBe("claude");
    expect(resolveWorkerBin("codex")).toBe("codex");
    expect(resolveWorkerBin("gemini")).toBe("gemini");
  });
  it("falls through to the role string for unknown roles", () => {
    expect(resolveWorkerBin("custom-bin")).toBe("custom-bin");
  });
});

describe("startTeam", () => {
  it("creates one task + one pane per worker and writes inbox/config", async () => {
    const cwd = tempCwd();
    const { api, calls } = mockTmux();
    const result = await startTeam({
      cwd,
      name: "demo",
      role: "claude",
      workerCount: 2,
      task: "fix things",
      tmux: api,
    });
    expect(result.ok).toBe(true);
    expect(result.config.workers).toHaveLength(2);
    expect(result.config.tmuxSession).toBe("omc-team-demo");

    const paths = resolveTeamPaths(cwd, "demo");
    expect(existsSync(paths.configFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(paths.configFile, "utf8")) as TeamConfig;
    expect(persisted.workers).toHaveLength(2);

    const worker1 = resolveWorkerPaths(paths, "worker-1");
    expect(existsSync(worker1.inboxFile)).toBe(true);
    expect(readFileSync(worker1.inboxFile, "utf8")).toContain("omp team api claim-task");

    // tmux call sequence: new-session, then per worker: split + send-text + send-keys
    expect(calls[0]?.[0]).toBe("new-session");
    const splits = calls.filter((c) => c[0] === "split-window");
    expect(splits).toHaveLength(2);
  });

  it("refuses to start when the session already exists", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    (api.sessionExists as unknown) = () => true;
    await expect(
      startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("monitorTeam", () => {
  it("returns all-done when every task reaches a terminal status", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });
    // simulate worker completing the task via the api
    const claim = apiClaimTask({ team_name: "demo", task_id: "1", worker: "worker-1", cwd });
    apiTransitionTaskStatus({
      team_name: "demo",
      task_id: "1",
      worker: "worker-1",
      from: "in_progress",
      to: "completed",
      claim_token: claim.claimToken!,
      result: "ok",
      cwd,
    });
    const result = await monitorTeam({
      cwd,
      name: "demo",
      tmux: api,
      pollIntervalMs: 10,
      timeoutMs: 5_000,
    });
    expect(result.reason).toBe("all-done");
    expect(result.finalSnapshot.allDone).toBe(true);
  });

  it("times out when no progress is made", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });
    const result = await monitorTeam({
      cwd,
      name: "demo",
      tmux: api,
      pollIntervalMs: 10,
      timeoutMs: 50,
    });
    expect(result.reason).toBe("timeout");
    expect(result.ok).toBe(false);
  });
});

describe("statusTeam + shutdownTeam", () => {
  it("reports tasks + workers + then writes shutdown file", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });
    const report = statusTeam({ cwd, name: "demo", tmux: api });
    expect(report.ok).toBe(true);
    expect(report.snapshot?.tasks).toHaveLength(1);
    const formatted = formatStatus(report);
    expect(formatted).toContain("team demo");
    expect(formatted).toContain("Workers:");

    const shutdown = await shutdownTeam({ cwd, name: "demo", tmux: api });
    expect(shutdown.ok).toBe(true);
    expect(shutdown.killedPanes).toBe(1);
    expect(shutdown.killedSession).toBe(true);
    expect(typeof shutdown.clearedLocks).toBe("number");

    const paths = resolveTeamPaths(cwd, "demo");
    expect(existsSync(paths.shutdownFile)).toBe(true);
  });

  it("loadTeamConfig returns undefined when there's no team", () => {
    const cwd = tempCwd();
    const paths = resolveTeamPaths(cwd, "nope");
    expect(loadTeamConfig(paths)).toBeUndefined();
  });
});

describe("statusTeam is non-destructive", () => {
  it("does not consume outbox messages a concurrent monitor would read", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });

    // Worker emits an outbox message via the api
    const claim = apiClaimTask({ team_name: "demo", task_id: "1", worker: "worker-1", cwd });
    apiTransitionTaskStatus({
      team_name: "demo",
      task_id: "1",
      worker: "worker-1",
      from: "in_progress",
      to: "completed",
      claim_token: claim.claimToken!,
      cwd,
    });

    // Status (peek) — should see 1 new outbox message.
    const status1 = statusTeam({ cwd, name: "demo", tmux: api });
    expect(status1.snapshot?.workers[0]?.outboxNewCount).toBe(1);
    // Calling status again should still see the same 1 message — cursor untouched.
    const status2 = statusTeam({ cwd, name: "demo", tmux: api });
    expect(status2.snapshot?.workers[0]?.outboxNewCount).toBe(1);

    // monitorTeam (consuming) sees the message once, then it's drained.
    const monitor = await monitorTeam({
      cwd,
      name: "demo",
      tmux: api,
      pollIntervalMs: 5,
      timeoutMs: 200,
      maxTicks: 2,
    });
    expect(monitor.reason).toBe("all-done");
  });
});

describe("pollSnapshot", () => {
  it("marks allDone false when no tasks exist yet", async () => {
    const cwd = tempCwd();
    const { api } = mockTmux();
    await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });
    const paths = resolveTeamPaths(cwd, "demo");
    const config = loadTeamConfig(paths)!;
    // Force empty task list
    require("node:fs").rmSync(paths.tasksDir, { recursive: true, force: true });
    const snap = pollSnapshot(paths, config, api);
    expect(snap.allDone).toBe(false);
  });

  it("snapshots dead panes", async () => {
    const cwd = tempCwd();
    const { api, deadPanes } = mockTmux();
    const start = await startTeam({ cwd, name: "demo", role: "claude", workerCount: 1, task: "x", tmux: api });
    const pane = start.config.workers[0]?.paneId!;
    deadPanes.add(pane);
    const paths = resolveTeamPaths(cwd, "demo");
    const config = loadTeamConfig(paths)!;
    const snap = pollSnapshot(paths, config, api);
    expect(snap.workers[0]?.paneDead).toBe(true);
  });
});
