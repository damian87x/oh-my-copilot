import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apiClaimTask, apiTransitionTaskStatus } from "../../src/team/api.js";
import { resolveTeamPaths, resolveWorkerPaths, ensureTeamDirs } from "../../src/team/state-paths.js";
import { taskFilePath, writeTask } from "../../src/team/task-store.js";
import { readNewOutbox } from "../../src/team/outbox.js";

function setup(): { cwd: string; teamName: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-api-"));
  const teamName = "demo";
  const paths = resolveTeamPaths(cwd, teamName);
  ensureTeamDirs(paths);
  writeTask(taskFilePath(paths.tasksDir, "1"), {
    id: "1",
    description: "do thing",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  return { cwd, teamName };
}

describe("apiClaimTask", () => {
  it("claims the task and writes a worker heartbeat", () => {
    const { cwd, teamName } = setup();
    const claim = apiClaimTask({ team_name: teamName, task_id: "1", worker: "worker-1", cwd });
    expect(claim.ok).toBe(true);
    const paths = resolveTeamPaths(cwd, teamName);
    const worker = resolveWorkerPaths(paths, "worker-1");
    expect(existsSync(worker.heartbeatFile)).toBe(true);
  });

  it("rejects traversal-shaped task ids before task-store path construction", () => {
    const { cwd, teamName } = setup();
    const claim = apiClaimTask({ team_name: teamName, task_id: "../escape", worker: "worker-1", cwd });

    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe("invalid_task_id");
  });
});

describe("apiTransitionTaskStatus", () => {
  it("transitions a claimed task to completed and appends an outbox message", () => {
    const { cwd, teamName } = setup();
    const claim = apiClaimTask({ team_name: teamName, task_id: "1", worker: "worker-1", cwd });
    expect(claim.ok).toBe(true);

    const transition = apiTransitionTaskStatus({
      team_name: teamName,
      task_id: "1",
      worker: "worker-1",
      from: "in_progress",
      to: "completed",
      claim_token: claim.claimToken!,
      result: "done",
      cwd,
    });
    expect(transition.ok).toBe(true);
    expect(transition.task?.status).toBe("completed");

    const paths = resolveTeamPaths(cwd, teamName);
    const worker = resolveWorkerPaths(paths, "worker-1");
    const messages = readNewOutbox(worker.outboxFile, worker.outboxOffsetFile);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("task_complete");
    expect(messages[0]?.taskId).toBe("1");
  });

  it("rejects transitions with a wrong claim token", () => {
    const { cwd, teamName } = setup();
    apiClaimTask({ team_name: teamName, task_id: "1", worker: "worker-1", cwd });
    const result = apiTransitionTaskStatus({
      team_name: teamName,
      task_id: "1",
      worker: "worker-1",
      from: "in_progress",
      to: "completed",
      claim_token: "WRONG",
      cwd,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects traversal-shaped task ids before transition path construction", () => {
    const { cwd, teamName } = setup();
    const result = apiTransitionTaskStatus({
      team_name: teamName,
      task_id: "../escape",
      worker: "worker-1",
      from: "in_progress",
      to: "completed",
      claim_token: "token",
      cwd,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_task_id");
  });
});
