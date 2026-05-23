import { resolve } from "node:path";
import { resolveTeamPaths, resolveWorkerPaths } from "./state-paths.js";
import { tryClaimTask, transitionTask, type ClaimResult, type TransitionResult } from "./task-store.js";
import { writeHeartbeat } from "./heartbeat.js";
import { appendOutbox } from "./outbox.js";
import type { TaskStatus } from "./types.js";

export interface ClaimInput {
  team_name: string;
  task_id: string;
  worker: string;
  cwd?: string;
}

export function apiClaimTask(input: ClaimInput): ClaimResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  const team = resolveTeamPaths(cwd, input.team_name);
  const worker = resolveWorkerPaths(team, input.worker);
  const result = tryClaimTask({ tasksDir: team.tasksDir, taskId: input.task_id, worker: input.worker });
  if (result.ok) {
    writeHeartbeat(worker.heartbeatFile, {
      pid: process.pid,
      workerName: input.worker,
      teamName: input.team_name,
      lastPollAt: new Date().toISOString(),
      turnCount: 1,
      alive: true,
    });
  }
  return result;
}

export interface TransitionInput {
  team_name: string;
  task_id: string;
  worker?: string;
  from: TaskStatus;
  to: TaskStatus;
  claim_token: string;
  result?: string;
  cwd?: string;
}

export function apiTransitionTaskStatus(input: TransitionInput): TransitionResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  const team = resolveTeamPaths(cwd, input.team_name);
  const transition = transitionTask({
    tasksDir: team.tasksDir,
    taskId: input.task_id,
    from: input.from,
    to: input.to,
    claimToken: input.claim_token,
    result: input.result,
  });
  if (transition.ok && input.worker) {
    const worker = resolveWorkerPaths(team, input.worker);
    const messageType =
      input.to === "completed" ? "task_complete" : input.to === "failed" ? "task_failed" : "progress";
    appendOutbox(worker.outboxFile, {
      type: messageType,
      taskId: input.task_id,
      status: input.to,
      result: input.result,
      timestamp: new Date().toISOString(),
    });
    writeHeartbeat(worker.heartbeatFile, {
      pid: process.pid,
      workerName: input.worker,
      teamName: input.team_name,
      lastPollAt: new Date().toISOString(),
      turnCount: 2,
      alive: input.to === "in_progress",
    });
  }
  return transition;
}
