import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isLoopModeActive } from "../mode-state/paths.js";
import { ompRoot } from "../omp-root.js";
import { atomicWrite } from "../utils/fs.js";
import {
  collectDeliveries,
  readManifest,
} from "./collect.js";
import {
  DEFAULT_NUDGE_CONFIG,
  NudgeTracker,
  type NudgeAttempt,
  type NudgeTrackerSnapshot,
} from "./idle-nudge.js";
import {
  ownsLoopTeamMonitor,
  TEAM_MONITOR_TIMING,
} from "./monitor-supervisor.js";
import {
  ensureTeamMonitorDirs,
  resolveTeamMonitorPaths,
  resolveTeamPaths,
} from "./state-paths.js";
import { listTasks } from "./task-store.js";
import {
  makeTmuxForSocket,
  sendToWorker,
  type TmuxApi,
  type TmuxPaneContext,
} from "./tmux.js";
import type { TeamConfig, TeamTmuxIdentity } from "./types.js";
import type { VisualTeamRegistration } from "./visual-registration.js";
import {
  removeTokenFileIfMatches,
} from "./token-file.js";

interface BaseTarget {
  kind: "runtime" | "visual";
  targetId: string;
  teamName: string;
  generation: string;
  paneId: string;
  tmux: TmuxApi;
}

interface RuntimeTarget extends BaseTarget {
  kind: "runtime";
  tmuxSession: string;
  tmuxIdentity: TeamTmuxIdentity;
  configFile: string;
  tasksDir: string;
  shutdownFile: string;
}

interface VisualTarget extends BaseTarget {
  kind: "visual";
  laneId: string;
  registrationFile: string;
  deliveryDir: string;
  manifestPath: string;
  socketPath: string;
  serverPid: number;
  serverStartedAt: number;
  sessionId: string;
  sessionCreatedAt: number;
  windowId: string;
  launchId: string;
}

type MonitorTarget = RuntimeTarget | VisualTarget;

interface PersistedTargetState {
  schemaVersion: 1;
  targetId: string;
  kind: MonitorTarget["kind"];
  teamName: string;
  generation: string;
  paneId: string;
  revision: number;
  lastSeenAt: string;
  tracker: NudgeTrackerSnapshot;
}

interface TargetLock {
  token: string;
  acquiredAt: string;
  pid: number;
}

interface TargetLockHandle {
  release: () => void;
}

export interface LoopMonitorScanDeps {
  now?: () => number;
  attemptId?: () => string;
  tmux?: TmuxApi;
  tmuxForSocket?: (socketPath: string) => TmuxApi;
  send?: (tmux: TmuxApi, paneId: string, message: string) => Promise<boolean>;
}

export interface LoopMonitorScanResult {
  targetsScanned: number;
  attempts: NudgeAttempt[];
  diagnostics: string[];
}

function safeTargetId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function parseTeamConfig(path: string): TeamConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as TeamConfig;
  const identity = value?.tmuxIdentity;
  if (
    !value ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.tmuxSession !== "string" ||
    typeof value.cwd !== "string" ||
    !identity ||
    !isAbsolute(identity.socketPath) ||
    !Number.isInteger(identity.serverPid) ||
    !Number.isFinite(identity.serverStartedAt) ||
    typeof identity.sessionId !== "string" ||
    !identity.sessionId ||
    !Number.isFinite(identity.sessionCreatedAt) ||
    typeof identity.windowId !== "string" ||
    !identity.windowId ||
    !Array.isArray(value.workers)
  ) {
    throw new Error("invalid team config");
  }
  return value;
}

function discoverRuntimeTargets(
  cwd: string,
  tmuxForSocket: (socketPath: string) => TmuxApi,
  diagnostics: string[],
): RuntimeTarget[] {
  const root = ompRoot(cwd);
  const teamRoot = join(root, ".omp", "state", "team");
  const entries = (() => {
    try {
      return readdirSync(teamRoot, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  const targets: RuntimeTarget[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let paths: ReturnType<typeof resolveTeamPaths>;
    try {
      paths = resolveTeamPaths(root, entry.name);
    } catch (error) {
      diagnostics.push(
        `runtime team ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (existsSync(paths.shutdownFile)) continue;
    let config: TeamConfig;
    try {
      config = parseTeamConfig(paths.configFile);
    } catch (error) {
      diagnostics.push(
        `runtime team ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const tasks = listTasks(paths.tasksDir);
    if (
      tasks.length > 0 &&
      tasks.every((task) => task.status === "completed" || task.status === "failed")
    ) {
      continue;
    }
    let tmux: TmuxApi;
    try {
      tmux = tmuxForSocket(config.tmuxIdentity!.socketPath);
    } catch (error) {
      diagnostics.push(
        `runtime team ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!tmux.sessionExists(config.tmuxSession)) continue;
    for (const worker of config.workers) {
      if (!worker.paneId || tmux.paneDead(worker.paneId)) continue;
      const target: RuntimeTarget = {
        kind: "runtime",
        targetId: safeTargetId([
          "runtime",
          config.name,
          config.createdAt,
          worker.paneId,
          config.tmuxIdentity!.socketPath,
          String(config.tmuxIdentity!.serverPid),
          String(config.tmuxIdentity!.serverStartedAt),
          config.tmuxIdentity!.sessionId,
          String(config.tmuxIdentity!.sessionCreatedAt),
          config.tmuxIdentity!.windowId,
        ]),
        teamName: config.name,
        generation: config.createdAt,
        paneId: worker.paneId,
        tmux,
        tmuxSession: config.tmuxSession,
        tmuxIdentity: config.tmuxIdentity!,
        configFile: paths.configFile,
        tasksDir: paths.tasksDir,
        shutdownFile: paths.shutdownFile,
      };
      if (runtimeTargetStillLive(target, root)) {
        targets.push(target);
      } else {
        diagnostics.push(
          `runtime team ${config.name} pane ${worker.paneId}: tmux identity or task state is not live`,
        );
      }
    }
  }
  return targets;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    )
  );
}

function visualContextMatches(
  target: VisualTarget,
  context: TmuxPaneContext | undefined,
  projectRoot: string,
): boolean {
  if (!context || context.dead) return false;
  let currentPath: string;
  let realProjectRoot: string;
  try {
    currentPath = realpathSync(context.currentPath);
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    return false;
  }
  return (
    context.socketPath === target.socketPath &&
    context.serverPid === target.serverPid &&
    context.serverStartedAt === target.serverStartedAt &&
    context.sessionId === target.sessionId &&
    context.sessionCreatedAt === target.sessionCreatedAt &&
    context.windowId === target.windowId &&
    context.paneId === target.paneId &&
    context.launchId === target.launchId &&
    context.laneId === target.laneId &&
    isInside(realProjectRoot, currentPath)
  );
}

function runtimeContextMatches(
  target: RuntimeTarget,
  context: TmuxPaneContext | undefined,
  projectRoot: string,
): boolean {
  if (!context || context.dead) return false;
  let currentPath: string;
  let realProjectRoot: string;
  try {
    currentPath = realpathSync(context.currentPath);
    realProjectRoot = realpathSync(projectRoot);
  } catch {
    return false;
  }
  const identity = target.tmuxIdentity;
  return (
    context.socketPath === identity.socketPath &&
    context.serverPid === identity.serverPid &&
    context.serverStartedAt === identity.serverStartedAt &&
    context.sessionId === identity.sessionId &&
    context.sessionCreatedAt === identity.sessionCreatedAt &&
    context.windowId === identity.windowId &&
    context.paneId === target.paneId &&
    isInside(realProjectRoot, currentPath)
  );
}

function sameRuntimeIdentity(
  left: TeamTmuxIdentity | undefined,
  right: TeamTmuxIdentity,
): boolean {
  return Boolean(
    left &&
    left.socketPath === right.socketPath &&
    left.serverPid === right.serverPid &&
    left.serverStartedAt === right.serverStartedAt &&
    left.sessionId === right.sessionId &&
    left.sessionCreatedAt === right.sessionCreatedAt &&
    left.windowId === right.windowId
  );
}

function runtimeTargetStillLive(
  target: RuntimeTarget,
  projectRoot: string,
): boolean {
  if (
    existsSync(target.shutdownFile) ||
    !target.tmux.paneContext ||
    !target.tmux.sessionExists(target.tmuxSession) ||
    !runtimeContextMatches(
      target,
      target.tmux.paneContext(target.paneId),
      projectRoot,
    )
  ) {
    return false;
  }
  let config: TeamConfig;
  try {
    config = parseTeamConfig(target.configFile);
  } catch {
    return false;
  }
  if (
    config.createdAt !== target.generation ||
    config.tmuxSession !== target.tmuxSession ||
    !sameRuntimeIdentity(config.tmuxIdentity, target.tmuxIdentity) ||
    !config.workers.some((worker) => worker.paneId === target.paneId)
  ) {
    return false;
  }
  const tasks = listTasks(target.tasksDir);
  return !existsSync(target.shutdownFile) && !(
    tasks.length > 0 &&
    tasks.every((task) => task.status === "completed" || task.status === "failed")
  );
}

function visualTargetStillLive(target: VisualTarget, projectRoot: string): boolean {
  if (
    !existsSync(target.registrationFile) ||
    !existsSync(target.manifestPath) ||
    !target.tmux.paneContext ||
    !visualContextMatches(
      target,
      target.tmux.paneContext(target.paneId),
      projectRoot,
    )
  ) {
    return false;
  }
  const lane = readManifest(target.deliveryDir).find(
    (candidate) =>
      candidate.id === target.laneId &&
      candidate.paneId === target.paneId,
  );
  if (!lane) return false;
  return existsSync(target.registrationFile) && collectDeliveries(target.deliveryDir, [lane], {
    tmux: target.tmux,
  }).lanes[0]?.status === "working";
}

function discoverVisualTargets(
  cwd: string,
  tmuxForSocket: (socketPath: string) => TmuxApi,
  diagnostics: string[],
): VisualTarget[] {
  const root = ompRoot(cwd);
  const visualDir = resolveTeamMonitorPaths(root).visualDir;
  const entries = (() => {
    try {
      return readdirSync(visualDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  const targets: VisualTarget[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const registrationFile = join(visualDir, entry.name);
    let registration: VisualTeamRegistration;
    try {
      registration = JSON.parse(
        readFileSync(registrationFile, "utf8"),
      ) as VisualTeamRegistration;
      if (
        registration.schemaVersion !== 1 ||
        registration.projectRoot !== root ||
        !Array.isArray(registration.panes) ||
        registration.panes.length === 0
      ) {
        throw new Error("invalid visual registration");
      }
    } catch (error) {
      diagnostics.push(
        `visual registration ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    let tmux: TmuxApi;
    try {
      tmux = tmuxForSocket(registration.socketPath);
    } catch (error) {
      diagnostics.push(
        `visual registration ${registration.registrationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    for (const pane of registration.panes) {
      const target: VisualTarget = {
        kind: "visual",
        targetId: safeTargetId([
          "visual",
          registration.registrationId,
          registration.generation,
          pane.paneId,
          registration.socketPath,
        ]),
        teamName: registration.teamName,
        generation: registration.generation,
        paneId: pane.paneId,
        tmux,
        laneId: pane.laneId,
        registrationFile,
        deliveryDir: registration.deliveryDir,
        manifestPath: registration.manifestPath,
        socketPath: registration.socketPath,
        serverPid: registration.serverPid,
        serverStartedAt: registration.serverStartedAt,
        sessionId: registration.sessionId,
        sessionCreatedAt: registration.sessionCreatedAt,
        windowId: registration.windowId,
        launchId: registration.launchId,
      };
      if (visualTargetStillLive(target, root)) {
        targets.push(target);
      } else {
        diagnostics.push(
          `visual team ${registration.teamName} pane ${pane.paneId}: identity or lane state is not live`,
        );
      }
    }
  }
  return targets;
}

function readTargetState(path: string): PersistedTargetState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PersistedTargetState;
    return value?.schemaVersion === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readTargetLock(path: string): TargetLock | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TargetLock;
  } catch {
    return undefined;
  }
}

function releaseStaleTargetLock(path: string, now: number): void {
  const lock = readTargetLock(path);
  const acquiredAt = lock ? Date.parse(lock.acquiredAt) : Number.NaN;
  if (
    lock &&
    Number.isFinite(acquiredAt) &&
    now - acquiredAt <= TEAM_MONITOR_TIMING.targetLockStaleMs
  ) {
    return;
  }
  removeTokenFileIfMatches(path, lock?.token);
}

function acquireTargetLock(path: string, now: number): TargetLockHandle | undefined {
  const token = randomUUID();
  const lock: TargetLock = {
    token,
    acquiredAt: new Date(now).toISOString(),
    pid: process.pid,
  };
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    releaseStaleTargetLock(path, now);
    // Never reopen in the same scan after inspecting/removing a stale lock.
    // A later scan can acquire the now-empty path with O_EXCL without a
    // check-then-use window.
    return undefined;
  }
  try {
    writeSync(fd, `${JSON.stringify(lock)}\n`);
  } finally {
    closeSync(fd);
  }
  return {
    release: () => {
      if (readTargetLock(path)?.token !== token) return;
      removeTokenFileIfMatches(path, token);
    },
  };
}

function compactTerminalTargetStates(
  targetsDir: string,
  activeTargetIds: Set<string>,
  now: number,
): void {
  const entries = (() => {
    try {
      return readdirSync(targetsDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const targetId = entry.name.slice(0, -".json".length);
    if (activeTargetIds.has(targetId)) continue;
    const stateFile = join(targetsDir, entry.name);
    const state = readTargetState(stateFile);
    const lastSeenAt = state ? Date.parse(state.lastSeenAt) : Number.NaN;
    if (
      !Number.isFinite(lastSeenAt) ||
      now - lastSeenAt <= TEAM_MONITOR_TIMING.terminalStateGraceMs
    ) {
      continue;
    }
    const lockFile = join(targetsDir, `${targetId}.lock`);
    const lock = acquireTargetLock(lockFile, now);
    if (!lock) continue;
    try {
      const current = readTargetState(stateFile);
      const currentLastSeenAt = current
        ? Date.parse(current.lastSeenAt)
        : Number.NaN;
      if (
        current &&
        !activeTargetIds.has(targetId) &&
        Number.isFinite(currentLastSeenAt) &&
        now - currentLastSeenAt > TEAM_MONITOR_TIMING.terminalStateGraceMs
      ) {
        try {
          unlinkSync(stateFile);
        } catch {
          // The state was concurrently compacted.
        }
      }
    } finally {
      lock.release();
    }
  }
}

function targetStillLive(target: MonitorTarget, projectRoot: string): boolean {
  if (target.kind === "visual") {
    return visualTargetStillLive(target, projectRoot);
  }
  return runtimeTargetStillLive(target, projectRoot);
}

function writeTargetState(
  path: string,
  target: MonitorTarget,
  previous: PersistedTargetState | undefined,
  tracker: NudgeTracker,
  now: number,
): PersistedTargetState {
  const next: PersistedTargetState = {
    schemaVersion: 1,
    targetId: target.targetId,
    kind: target.kind,
    teamName: target.teamName,
    generation: target.generation,
    paneId: target.paneId,
    revision: (previous?.revision ?? 0) + 1,
    lastSeenAt: new Date(now).toISOString(),
    tracker: tracker.snapshot(),
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function scanLoopTeamMonitorOnce(
  cwd: string,
  ownerToken: string,
  deps: LoopMonitorScanDeps = {},
): Promise<LoopMonitorScanResult> {
  const root = ompRoot(cwd);
  const now = (deps.now ?? Date.now)();
  const tmuxForSocket = deps.tmuxForSocket ?? makeTmuxForSocket;
  const runtimeTmuxForSocket = deps.tmux
    ? () => deps.tmux!
    : tmuxForSocket;
  const diagnostics: string[] = [];
  const attempts: NudgeAttempt[] = [];
  if (!isLoopModeActive(root) || !ownsLoopTeamMonitor(root, ownerToken)) {
    return { targetsScanned: 0, attempts, diagnostics };
  }

  const paths = resolveTeamMonitorPaths(root);
  ensureTeamMonitorDirs(paths);
  const targets: MonitorTarget[] = [
    ...discoverRuntimeTargets(root, runtimeTmuxForSocket, diagnostics),
    ...discoverVisualTargets(root, tmuxForSocket, diagnostics),
  ];
  const activeTargetIds = new Set(targets.map((target) => target.targetId));
  for (const target of targets) {
    const stateFile = join(paths.targetsDir, `${target.targetId}.json`);
    const lockFile = join(paths.targetsDir, `${target.targetId}.lock`);
    const lock = acquireTargetLock(lockFile, now);
    if (!lock) {
      diagnostics.push(
        `${target.kind} team ${target.teamName} pane ${target.paneId}: target lock busy`,
      );
      continue;
    }

    let reservation: Omit<NudgeAttempt, "outcome"> | undefined;
    let reservationRevision: number | undefined;
    try {
      if (
        !isLoopModeActive(root) ||
        !ownsLoopTeamMonitor(root, ownerToken) ||
        !targetStillLive(target, root)
      ) {
        continue;
      }
      const previous = readTargetState(stateFile);
      const matching =
        previous?.targetId === target.targetId &&
        previous.generation === target.generation &&
        previous.paneId === target.paneId
          ? previous
          : undefined;
      const tracker = new NudgeTracker({}, matching?.tracker);
      const due = tracker.observePanes(
        target.tmux,
        [target.paneId],
        undefined,
        now,
      );
      if (due.length > 0) {
        reservation = tracker.reserveNudge(
          target.paneId,
          (deps.attemptId ?? randomUUID)(),
          now,
        );
      }
      const persisted = writeTargetState(
        stateFile,
        target,
        matching,
        tracker,
        now,
      );
      if (reservation) reservationRevision = persisted.revision;
    } finally {
      lock.release();
    }

    if (!reservation) continue;
    let outcome: NudgeAttempt["outcome"] = "skipped";
    const reservedState = readTargetState(stateFile);
    const reservationStillCurrent = Boolean(
      reservedState &&
      reservedState.revision === reservationRevision &&
      reservedState.tracker.panes.some(
        (pane) =>
          pane.paneId === target.paneId &&
          pane.lastAttempt?.attemptId === reservation.attemptId &&
          pane.lastAttempt.outcome === "reserved",
      ),
    );
    if (
      reservationStillCurrent &&
      isLoopModeActive(root) &&
      ownsLoopTeamMonitor(root, ownerToken) &&
      targetStillLive(target, root)
    ) {
      try {
        const send = deps.send ??
          ((api: TmuxApi, paneId: string, message: string) =>
            sendToWorker(api, paneId, message));
        outcome = await send(
          target.tmux,
          target.paneId,
          DEFAULT_NUDGE_CONFIG.message,
        )
          ? "sent"
          : "failed";
      } catch {
        outcome = "failed";
      }
    }

    const outcomeLock = acquireTargetLock(lockFile, now);
    if (outcomeLock) {
      try {
        const current = readTargetState(stateFile);
        if (
          current?.tracker.panes.some(
            (pane) =>
              pane.paneId === target.paneId &&
              pane.lastAttempt?.attemptId === reservation.attemptId,
          )
        ) {
          const tracker = new NudgeTracker({}, current.tracker);
          tracker.recordNudgeOutcome(
            target.paneId,
            reservation.attemptId,
            outcome,
            now,
          );
          writeTargetState(stateFile, target, current, tracker, now);
        }
      } finally {
        outcomeLock.release();
      }
    }
    attempts.push({ ...reservation, outcome });
  }

  compactTerminalTargetStates(paths.targetsDir, activeTargetIds, now);
  return { targetsScanned: targets.length, attempts, diagnostics };
}
