import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureTeamDirs,
  ensureWorkerDirs,
  resolveTeamPaths,
  resolveWorkerPaths,
  type TeamStatePaths,
} from "./state-paths.js";
import { listTasks, readTask, taskFilePath, writeTask } from "./task-store.js";
import { writeInbox } from "./inbox.js";
import { buildInboxMarkdown } from "./worker-bootstrap.js";
import { readNewOutbox } from "./outbox.js";
import { isHeartbeatStale, readHeartbeat } from "./heartbeat.js";
import { makeTmux, type TmuxApi } from "./tmux.js";
import { NudgeTracker, type NudgeAttempt, type NudgeConfig, type NudgeSummaryEntry } from "./idle-nudge.js";
import type { Task, TeamConfig, Worker, WorkerRole } from "./types.js";

const ROLE_BIN: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
};

export function resolveWorkerBin(role: WorkerRole): string {
  return ROLE_BIN[role] ?? role;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface StartTeamOptions {
  cwd?: string;
  name: string;
  role: WorkerRole;
  workerCount: number;
  task: string;
  tmux?: TmuxApi;
  workerBinOverride?: string;
}

export interface StartTeamResult {
  ok: boolean;
  config: TeamConfig;
  tmuxSession: string;
  paths: TeamStatePaths;
}

export async function startTeam(opts: StartTeamOptions): Promise<StartTeamResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tmux = opts.tmux ?? makeTmux();
  const paths = resolveTeamPaths(cwd, opts.name);
  ensureTeamDirs(paths);

  const tasks: Task[] = [];
  for (let i = 0; i < opts.workerCount; i++) {
    const id = String(i + 1);
    const description =
      opts.workerCount === 1 ? opts.task : `${opts.task} (part ${i + 1}/${opts.workerCount})`;
    const task: Task = {
      id,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    writeTask(taskFilePath(paths.tasksDir, id), task);
    tasks.push(task);
  }

  const sessionName = `omc-team-${opts.name}`;
  if (tmux.sessionExists(sessionName)) {
    throw new Error(`tmux session ${sessionName} already exists; run \`omc team shutdown ${opts.name}\` first`);
  }
  const newSess = tmux.newSession(sessionName, cwd);
  if (newSess.status !== 0) {
    throw new Error(`tmux new-session failed: ${newSess.stderr || newSess.stdout}`);
  }
  const leaderPaneMatch = newSess.stdout.match(/(%\d+)/);
  let lastTarget = leaderPaneMatch?.[1] ?? sessionName;
  const workers: Worker[] = [];
  const bin = opts.workerBinOverride ?? resolveWorkerBin(opts.role);

  for (let i = 0; i < opts.workerCount; i++) {
    const workerName = `worker-${i + 1}`;
    const split = tmux.splitWindow(lastTarget, cwd);
    if (split.status !== 0) {
      throw new Error(`tmux split-window failed: ${split.stderr || split.stdout}`);
    }
    const paneId = split.stdout.trim();
    lastTarget = paneId;
    const task = tasks[i]!;
    workers.push({ name: workerName, role: opts.role, paneId, taskId: task.id });

    const wp = resolveWorkerPaths(paths, workerName);
    ensureWorkerDirs(wp);
    writeInbox(wp.inboxFile, buildInboxMarkdown({ teamName: opts.name, workerName, task, cwd }));
    tmux.sendText(paneId, bin);
    tmux.sendKeys(paneId, "C-m");
  }

  const config: TeamConfig = {
    name: opts.name,
    task: opts.task,
    role: opts.role,
    workerCount: opts.workerCount,
    tmuxSession: sessionName,
    workers,
    cwd,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { ok: true, config, tmuxSession: sessionName, paths };
}

export interface MonitorOptions {
  cwd?: string;
  name: string;
  tmux?: TmuxApi;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onTick?: (snapshot: MonitorSnapshot) => void;
  maxTicks?: number;
  nudge?: Partial<NudgeConfig> & { enabled?: boolean };
}

export interface WorkerSnapshot {
  name: string;
  paneId?: string;
  paneDead: boolean;
  heartbeatStale: boolean;
  outboxNewCount: number;
}

export interface MonitorSnapshot {
  tasks: Task[];
  workers: WorkerSnapshot[];
  allDone: boolean;
}

export interface MonitorResult {
  ok: boolean;
  finalSnapshot: MonitorSnapshot;
  reason: "all-done" | "timeout" | "shutdown";
  ticks: number;
  nudges: NudgeSummaryEntry[];
  nudgeAttempts: NudgeAttempt[];
}

export function loadTeamConfig(paths: TeamStatePaths): TeamConfig | undefined {
  if (!existsSync(paths.configFile)) return undefined;
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8")) as TeamConfig;
  } catch {
    return undefined;
  }
}

export function pollSnapshot(paths: TeamStatePaths, config: TeamConfig, tmux: TmuxApi): MonitorSnapshot {
  const tasks = listTasks(paths.tasksDir);
  const workers: WorkerSnapshot[] = config.workers.map((w) => {
    const wp = resolveWorkerPaths(paths, w.name);
    const paneDead = w.paneId ? tmux.paneDead(w.paneId) : false;
    const heartbeatStale = isHeartbeatStale(readHeartbeat(wp.heartbeatFile));
    const newMessages = readNewOutbox(wp.outboxFile, wp.outboxOffsetFile);
    return {
      name: w.name,
      paneId: w.paneId,
      paneDead,
      heartbeatStale,
      outboxNewCount: newMessages.length,
    };
  });
  const allDone =
    tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "failed");
  return { tasks, workers, allDone };
}

export async function monitorTeam(opts: MonitorOptions): Promise<MonitorResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tmux = opts.tmux ?? makeTmux();
  const paths = resolveTeamPaths(cwd, opts.name);
  const config = loadTeamConfig(paths);
  if (!config) throw new Error(`team ${opts.name} not found at ${paths.configFile}`);

  const pollInterval = opts.pollIntervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  const nudgeEnabled = opts.nudge?.enabled !== false; // default on; opt-out via { enabled: false }
  const nudgeTracker = nudgeEnabled ? new NudgeTracker(opts.nudge) : undefined;
  const nudgeAttempts: NudgeAttempt[] = [];
  let snapshot: MonitorSnapshot = pollSnapshot(paths, config, tmux);
  let ticks = 0;

  while (Date.now() < deadline && (opts.maxTicks == null || ticks < opts.maxTicks)) {
    snapshot = pollSnapshot(paths, config, tmux);
    ticks++;
    opts.onTick?.(snapshot);

    if (nudgeTracker) {
      const panes = config.workers.map((w) => w.paneId).filter((id): id is string => Boolean(id));
      const attempts = await nudgeTracker.checkAndNudge(tmux, config.tmuxSession, panes);
      nudgeAttempts.push(...attempts);
    }

    if (existsSync(paths.shutdownFile)) {
      return {
        ok: snapshot.allDone,
        finalSnapshot: snapshot,
        reason: "shutdown",
        ticks,
        nudges: nudgeTracker?.getSummary() ?? [],
        nudgeAttempts,
      };
    }
    if (snapshot.allDone) {
      return {
        ok: true,
        finalSnapshot: snapshot,
        reason: "all-done",
        ticks,
        nudges: nudgeTracker?.getSummary() ?? [],
        nudgeAttempts,
      };
    }
    await sleep(pollInterval);
  }
  return {
    ok: false,
    finalSnapshot: snapshot,
    reason: "timeout",
    ticks,
    nudges: nudgeTracker?.getSummary() ?? [],
    nudgeAttempts,
  };
}

export interface ShutdownOptions {
  cwd?: string;
  name: string;
  tmux?: TmuxApi;
}

export interface ShutdownResult {
  ok: boolean;
  killedPanes: number;
  killedSession: boolean;
}

export async function shutdownTeam(opts: ShutdownOptions): Promise<ShutdownResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tmux = opts.tmux ?? makeTmux();
  const paths = resolveTeamPaths(cwd, opts.name);
  const config = loadTeamConfig(paths);
  if (!config) return { ok: false, killedPanes: 0, killedSession: false };

  let killedPanes = 0;
  for (const w of config.workers) {
    if (w.paneId) {
      const r = tmux.killPane(w.paneId);
      if (r.status === 0) killedPanes++;
    }
  }
  const session = tmux.killSession(config.tmuxSession);
  writeFileSync(paths.shutdownFile, `${JSON.stringify({ shutdownAt: new Date().toISOString() })}\n`, "utf8");
  return { ok: true, killedPanes, killedSession: session.status === 0 };
}

export interface StatusOptions {
  cwd?: string;
  name: string;
  tmux?: TmuxApi;
}

export interface StatusReport {
  ok: boolean;
  config?: TeamConfig;
  snapshot?: MonitorSnapshot;
  reason?: string;
}

export function statusTeam(opts: StatusOptions): StatusReport {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tmux = opts.tmux ?? makeTmux();
  const paths = resolveTeamPaths(cwd, opts.name);
  const config = loadTeamConfig(paths);
  if (!config) return { ok: false, reason: `team ${opts.name} not found` };
  const snapshot = pollSnapshot(paths, config, tmux);
  return { ok: true, config, snapshot };
}

export function formatStatus(report: StatusReport): string {
  if (!report.ok || !report.config || !report.snapshot) return `team status: ${report.reason ?? "unknown"}`;
  const lines = [
    `team ${report.config.name} (${report.config.role}, ${report.config.workerCount} workers)`,
    `session ${report.config.tmuxSession}`,
    "",
    "Tasks:",
  ];
  for (const t of report.snapshot.tasks) {
    lines.push(`  ${t.id}  ${t.status}  ${t.owner ?? "-"}  ${t.result ?? ""}`);
  }
  lines.push("", "Workers:");
  for (const w of report.snapshot.workers) {
    lines.push(
      `  ${w.name}  pane=${w.paneId ?? "-"}  dead=${w.paneDead}  hbStale=${w.heartbeatStale}  new=${w.outboxNewCount}`,
    );
  }
  lines.push("", `allDone=${report.snapshot.allDone}`);
  return lines.join("\n");
}
