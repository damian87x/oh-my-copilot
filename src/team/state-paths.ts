import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { statePath } from "../utils/paths.js";

export interface TeamStatePaths {
  cwd: string;
  teamName: string;
  teamRoot: string;
  configFile: string;
  manifestFile: string;
  shutdownFile: string;
  tasksDir: string;
  workersDir: string;
  mailboxDir: string;
  dispatchDir: string;
  eventsFile: string;
  monitorSnapshotFile: string;
  phaseStateFile: string;
  approvalsDir: string;
}

export interface WorkerStatePaths {
  workerRoot: string;
  inboxFile: string;
  outboxFile: string;
  outboxOffsetFile: string;
  heartbeatFile: string;
  readySentinel: string;
  statusFile: string;
  shutdownRequestFile: string;
  shutdownAckFile: string;
}

export function resolveTeamPaths(cwd: string, teamName: string): TeamStatePaths {
  const root = ompRoot(cwd);
  const teamRoot = statePath(root, "team", teamName);
  return {
    cwd: root,
    teamName,
    teamRoot,
    configFile: join(teamRoot, "config.json"),
    manifestFile: join(teamRoot, "manifest.json"),
    shutdownFile: join(teamRoot, "shutdown.json"),
    tasksDir: join(teamRoot, "tasks"),
    workersDir: join(teamRoot, "workers"),
    mailboxDir: join(teamRoot, "mailbox"),
    dispatchDir: join(teamRoot, "dispatch"),
    eventsFile: join(teamRoot, "events.jsonl"),
    monitorSnapshotFile: join(teamRoot, "monitor-snapshot.json"),
    phaseStateFile: join(teamRoot, "phase-state.json"),
    approvalsDir: join(teamRoot, "approvals"),
  };
}

export function resolveWorkerPaths(team: TeamStatePaths, workerName: string): WorkerStatePaths {
  const workerRoot = join(team.workersDir, workerName);
  return {
    workerRoot,
    inboxFile: join(workerRoot, "inbox.md"),
    outboxFile: join(workerRoot, "outbox.jsonl"),
    outboxOffsetFile: join(workerRoot, ".outbox-offset"),
    heartbeatFile: join(workerRoot, "heartbeat.json"),
    readySentinel: join(workerRoot, ".ready"),
    statusFile: join(workerRoot, "status.json"),
    shutdownRequestFile: join(workerRoot, "shutdown-request.json"),
    shutdownAckFile: join(workerRoot, "shutdown-ack.json"),
  };
}

export function ensureTeamDirs(paths: TeamStatePaths): void {
  for (const dir of [
    paths.teamRoot,
    paths.tasksDir,
    paths.workersDir,
    paths.mailboxDir,
    paths.dispatchDir,
    paths.approvalsDir,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function ensureWorkerDirs(worker: WorkerStatePaths): void {
  if (!existsSync(worker.workerRoot)) mkdirSync(worker.workerRoot, { recursive: true });
}
