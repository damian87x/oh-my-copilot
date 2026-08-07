import { join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { ensureTrustedParentDirectory } from "../utils/fs.js";
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
  cwd: string;
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

export interface TeamMonitorPaths {
  cwd: string;
  root: string;
  ownerFile: string;
  heartbeatFile: string;
  statusFile: string;
  eventsFile: string;
  visualDir: string;
  targetsDir: string;
}

function assertSafePathName(kind: "team" | "worker", value: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${kind} name: ${JSON.stringify(value)}`);
  }
}

export function resolveTeamPaths(cwd: string, teamName: string): TeamStatePaths {
  assertSafePathName("team", teamName);
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
  assertSafePathName("worker", workerName);
  const workerRoot = join(team.workersDir, workerName);
  return {
    cwd: team.cwd,
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

export function resolveTeamMonitorPaths(cwd: string): TeamMonitorPaths {
  const projectRoot = ompRoot(cwd);
  const root = statePath(projectRoot, "team-monitor");
  return {
    cwd: projectRoot,
    root,
    ownerFile: join(root, "owner.lock"),
    heartbeatFile: join(root, "heartbeat.json"),
    statusFile: join(root, "status.json"),
    eventsFile: join(root, "events.jsonl"),
    visualDir: join(root, "visual"),
    targetsDir: join(root, "targets"),
  };
}

function ensureTrustedDirectory(directory: string, projectRoot: string): void {
  ensureTrustedParentDirectory(
    join(directory, ".omp-directory-sentinel"),
    projectRoot,
  );
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
    ensureTrustedDirectory(dir, paths.cwd);
  }
}

export function ensureWorkerDirs(worker: WorkerStatePaths): void {
  ensureTrustedDirectory(worker.workerRoot, worker.cwd);
}

export function ensureTeamMonitorDirs(paths: TeamMonitorPaths): void {
  for (const dir of [paths.root, paths.visualDir, paths.targetsDir]) {
    ensureTrustedDirectory(dir, paths.cwd);
  }
}
