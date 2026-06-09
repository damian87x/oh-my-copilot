import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureTeamDirs,
  ensureWorkerDirs,
  resolveTeamPaths,
  resolveWorkerPaths,
  type TeamStatePaths,
} from "./state-paths.js";
import { clearAllLocks, listTasks, readTask, taskFilePath, writeTask } from "./task-store.js";
import { writeInbox } from "./inbox.js";
import { buildInboxMarkdown } from "./worker-bootstrap.js";
import { peekNewOutbox, readNewOutbox } from "./outbox.js";
import { isHeartbeatStale, readHeartbeat } from "./heartbeat.js";
import { makeTmux, sendToWorker, waitForReady, type TmuxApi } from "./tmux.js";
import { NudgeTracker, type NudgeAttempt, type NudgeConfig, type NudgeSummaryEntry } from "./idle-nudge.js";
import { loadTeamConfig } from "./config.js";
import { isLoopModeActive } from "../mode-state/paths.js";
import type { Task, TeamConfig, Worker, WorkerRole } from "./types.js";

const ROLE_BIN: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot --allow-all-tools",
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

  const sessionName = `omp-team-${opts.name}`;
  if (tmux.sessionExists(sessionName)) {
    throw new Error(`tmux session ${sessionName} already exists; run \`omp team shutdown ${opts.name}\` first`);
  }
  const newSess = tmux.newSession(sessionName, cwd);
  if (newSess.status !== 0) {
    throw new Error(`tmux new-session failed: ${newSess.stderr || newSess.stdout}`);
  }

  // From this point on, the tmux session exists. Any failure must kill it
  // before propagating, or the next startTeam will refuse with "session
  // already exists" and the user can't recover via `omp team shutdown`
  // (which reads config.json that we haven't written yet).
  try {
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

    // Wait for all workers to be ready (handles trust dialog), then send prompts
    for (let i = 0; i < opts.workerCount; i++) {
      const w = workers[i]!;
      const task = tasks[i]!;
      if (!w.paneId) continue;
      await waitForReady(tmux, w.paneId);
      const prompt = `Read your inbox at ${resolve(paths.workersDir, w.name, "inbox.md")} and follow the instructions exactly. Your task: ${task.description}`;
      await sendToWorker(tmux, w.paneId, prompt);
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
  } catch (err) {
    try {
      tmux.killSession(sessionName);
    } catch {
      // best effort — surface the original error to the caller
    }
    throw err;
  }
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

// loadTeamConfig now lives in ./config.js (leaf module) so api.ts can import it
// without depending on this orchestration module. Re-exported for back-compat.
export { loadTeamConfig };

export interface PollSnapshotOptions {
  consumeOutbox?: boolean;
}

export function pollSnapshot(
  paths: TeamStatePaths,
  config: TeamConfig,
  tmux: TmuxApi,
  options: PollSnapshotOptions = {},
): MonitorSnapshot {
  const reader = options.consumeOutbox === true ? readNewOutbox : peekNewOutbox;
  const tasks = listTasks(paths.tasksDir);
  const workers: WorkerSnapshot[] = config.workers.map((w) => {
    const wp = resolveWorkerPaths(paths, w.name);
    const paneDead = w.paneId ? tmux.paneDead(w.paneId) : false;
    const heartbeatStale = isHeartbeatStale(readHeartbeat(wp.heartbeatFile));
    const newMessages = reader(wp.outboxFile, wp.outboxOffsetFile);
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

/**
 * Resolve whether idle-nudge should run for this monitor session.
 * OFF by default. ON when explicitly enabled (the `/team` orchestration monitor
 * passes `nudge: { enabled: true }`) OR when a loop mode (ralph/ultrawork/ultraqa)
 * is active. Read-only polling (`team status`) passes neither signal → OFF.
 */
export function resolveNudgeEnabled(opts: MonitorOptions, cwd: string): boolean {
  if (opts.nudge?.enabled === true) return true;
  return isLoopModeActive(cwd);
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
  const nudgeEnabled = resolveNudgeEnabled(opts, cwd);
  const nudgeTracker = nudgeEnabled ? new NudgeTracker(opts.nudge) : undefined;
  const nudgeAttempts: NudgeAttempt[] = [];
  let snapshot: MonitorSnapshot = pollSnapshot(paths, config, tmux, { consumeOutbox: true });
  let ticks = 0;

  while (Date.now() < deadline && (opts.maxTicks == null || ticks < opts.maxTicks)) {
    snapshot = pollSnapshot(paths, config, tmux, { consumeOutbox: true });
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
  clearedLocks: number;
}

export async function shutdownTeam(opts: ShutdownOptions): Promise<ShutdownResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tmux = opts.tmux ?? makeTmux();
  const paths = resolveTeamPaths(cwd, opts.name);
  const config = loadTeamConfig(paths);

  // Fallback: even if config.json is missing or corrupt, still try to kill
  // the conventionally-named session — recovers from a startTeam that
  // crashed before writing config (pre-cleanup behaviour from the
  // try/catch above).
  if (!config) {
    const conventional = `omp-team-${opts.name}`;
    const exists = tmux.sessionExists(conventional);
    const session = exists ? tmux.killSession(conventional) : { status: 1, stdout: "", stderr: "" };
    const clearedLocks = clearAllLocks(paths.tasksDir);
    return {
      ok: exists || clearedLocks > 0,
      killedPanes: 0,
      killedSession: exists && session.status === 0,
      clearedLocks,
    };
  }

  let killedPanes = 0;
  for (const w of config.workers) {
    if (w.paneId) {
      const r = tmux.killPane(w.paneId);
      if (r.status === 0) killedPanes++;
    }
  }
  const session = tmux.killSession(config.tmuxSession);
  const clearedLocks = clearAllLocks(paths.tasksDir);
  writeFileSync(paths.shutdownFile, `${JSON.stringify({ shutdownAt: new Date().toISOString() })}\n`, "utf8");
  return { ok: true, killedPanes, killedSession: session.status === 0, clearedLocks };
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
