import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLoopModeActive,
  readModeStateJson,
  type LoopMode,
} from "../mode-state/paths.js";
import { ompRoot } from "../omp-root.js";
import { atomicWrite } from "../utils/fs.js";
import { statePath } from "../utils/paths.js";
import {
  ensureTeamMonitorDirs,
  resolveTeamMonitorPaths,
} from "./state-paths.js";
import type { TeamConfig } from "./types.js";
import type { LoopMonitorScanResult } from "./loop-monitor.js";
import { recordTeamMonitorEvent } from "./monitor-events.js";
import {
  readTokenFileToken,
  removeTokenFileIfMatches,
  replaceTokenFileIfMatches,
} from "./token-file.js";

export const TEAM_MONITOR_TIMING = {
  scanIntervalMs: 5_000,
  heartbeatIntervalMs: 5_000,
  pendingGraceMs: 15_000,
  runningStaleMs: 20_000,
  targetLockStaleMs: 15_000,
  noLiveTargetConsecutiveScanThreshold: 2,
  terminalStateGraceMs: 24 * 60 * 60 * 1_000,
  retainedEvents: 100,
} as const;

export interface MonitorChild {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  unref?: () => void;
}

export type MonitorSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => MonitorChild;

interface MonitorOwner {
  schemaVersion: 1;
  token: string;
  phase: "pending" | "running";
  parentPid: number;
  pid?: number;
  buildId?: string;
  createdAt: string;
  updatedAt?: string;
}

interface MonitorHeartbeat {
  schemaVersion: 1;
  token: string;
  pid: number;
  buildId: string;
  lastHeartbeatAt: string;
  activeLoops: LoopMode[];
}

export interface EnsureLoopTeamMonitorDeps {
  spawn?: MonitorSpawn;
  cliPath?: string;
  now?: () => number;
  token?: () => string;
  pid?: number;
}

export type EnsureLoopTeamMonitorResult =
  | { started: true; token: string }
  | {
      started: false;
      reason: "no-active-loop" | "no-live-targets" | "already-pending" | "already-running" | "spawn-failed";
      error?: string;
    };

export interface AdoptLoopTeamMonitorDeps {
  now?: () => number;
  pid?: number;
  buildId: string;
}

export type AdoptLoopTeamMonitorResult =
  | { adopted: true }
  | { adopted: false; reason: "owner-mismatch" };

export interface RunLoopTeamMonitorDeps extends AdoptLoopTeamMonitorDeps {
  scan?: () => Promise<LoopMonitorScanResult>;
  sleep?: (ms: number) => Promise<void>;
  maxScans?: number;
}

export interface RunLoopTeamMonitorResult {
  ok: boolean;
  reason: "no-active-loop" | "no-live-targets" | "owner-mismatch" | "owner-lost" | "max-scans" | "error";
  scans: number;
}

function ownerPath(cwd: string): string {
  return statePath(cwd, "team-monitor", "owner.lock");
}

function readOwner(path: string): MonitorOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MonitorOwner>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.token !== "string" ||
      !value.token ||
      (value.phase !== "pending" && value.phase !== "running") ||
      !Number.isInteger(value.parentPid) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      (
        value.phase === "running" &&
        (
          !Number.isInteger(value.pid) ||
          typeof value.buildId !== "string" ||
          !value.buildId ||
          typeof value.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(value.updatedAt))
        )
      )
    ) {
      return undefined;
    }
    return value as MonitorOwner;
  } catch {
    return undefined;
  }
}

function readMonitorHeartbeat(path: string): MonitorHeartbeat | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MonitorHeartbeat;
  } catch {
    return undefined;
  }
}

export function ownsLoopTeamMonitor(cwd: string, token: string): boolean {
  const owner = readOwner(resolveTeamMonitorPaths(cwd).ownerFile);
  return owner?.token === token && owner.phase === "running";
}

function activeLoopModes(cwd: string): LoopMode[] {
  const modes: LoopMode[] = ["ralph", "ultrawork", "ultraqa"];
  return modes.filter(
    (mode) => readModeStateJson<{ active?: boolean }>(cwd, mode)?.active === true,
  );
}

function releasePendingOwner(path: string, token: string): boolean {
  const owner = readOwner(path);
  if (owner?.token !== token || owner.phase !== "pending") return false;
  return removeTokenFileIfMatches(path, token);
}

function releaseOwnerWithToken(path: string, token: string): boolean {
  if (readOwner(path)?.token !== token) return false;
  return removeTokenFileIfMatches(path, token);
}

export function adoptLoopTeamMonitorOwner(
  cwd: string,
  token: string,
  deps: AdoptLoopTeamMonitorDeps,
): AdoptLoopTeamMonitorResult {
  const paths = resolveTeamMonitorPaths(cwd);
  const owner = readOwner(paths.ownerFile);
  if (owner?.token !== token || owner.phase !== "pending") {
    return { adopted: false, reason: "owner-mismatch" };
  }

  const now = (deps.now ?? Date.now)();
  const timestamp = new Date(now).toISOString();
  const pid = deps.pid ?? process.pid;
  const running: MonitorOwner = {
    ...owner,
    phase: "running",
    pid,
    buildId: deps.buildId,
    updatedAt: timestamp,
  };
  const heartbeat: MonitorHeartbeat = {
    schemaVersion: 1,
    token,
    pid,
    buildId: deps.buildId,
    lastHeartbeatAt: timestamp,
    activeLoops: activeLoopModes(cwd),
  };
  ensureTeamMonitorDirs(paths);
  if (
    !replaceTokenFileIfMatches(
      paths.ownerFile,
      token,
      `${JSON.stringify(running, null, 2)}\n`,
    )
  ) {
    return { adopted: false, reason: "owner-mismatch" };
  }
  atomicWrite(paths.heartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`);
  recordTeamMonitorEvent(
    cwd,
    { type: "owner-adopted", token, buildId: deps.buildId, at: now },
    TEAM_MONITOR_TIMING.retainedEvents,
  );
  return { adopted: true };
}

function refreshLoopTeamMonitorHeartbeat(
  cwd: string,
  token: string,
  deps: AdoptLoopTeamMonitorDeps,
): boolean {
  const paths = resolveTeamMonitorPaths(cwd);
  const owner = readOwner(paths.ownerFile);
  if (owner?.token !== token || owner.phase !== "running") return false;
  const now = (deps.now ?? Date.now)();
  const refreshedOwner: MonitorOwner = {
    ...owner,
    pid: deps.pid ?? process.pid,
    buildId: deps.buildId,
    updatedAt: new Date(now).toISOString(),
  };
  if (
    !replaceTokenFileIfMatches(
      paths.ownerFile,
      token,
      `${JSON.stringify(refreshedOwner, null, 2)}\n`,
    )
  ) {
    return false;
  }
  const heartbeat: MonitorHeartbeat = {
    schemaVersion: 1,
    token,
    pid: deps.pid ?? process.pid,
    buildId: deps.buildId,
    lastHeartbeatAt: new Date(now).toISOString(),
    activeLoops: activeLoopModes(cwd),
  };
  atomicWrite(paths.heartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`);
  return true;
}

function releaseLoopTeamMonitorOwner(cwd: string, token: string): void {
  const path = resolveTeamMonitorPaths(cwd).ownerFile;
  if (readOwner(path)?.token !== token) return;
  removeTokenFileIfMatches(path, token);
}

function writeMonitorStatus(
  cwd: string,
  token: string,
  scans: number,
  terminal: boolean,
  reason: RunLoopTeamMonitorResult["reason"] | "running",
  now: number,
  diagnostics: string[] = [],
): void {
  const paths = resolveTeamMonitorPaths(cwd);
  ensureTeamMonitorDirs(paths);
  atomicWrite(
    paths.statusFile,
    `${JSON.stringify({
      schemaVersion: 1,
      token,
      scans,
      terminal,
      reason,
      diagnostics,
      updatedAt: new Date(now).toISOString(),
    }, null, 2)}\n`,
  );
}

export async function runLoopTeamMonitor(
  cwd: string,
  token: string,
  deps: RunLoopTeamMonitorDeps,
): Promise<RunLoopTeamMonitorResult> {
  const root = ompRoot(cwd);
  const adopted = adoptLoopTeamMonitorOwner(root, token, deps);
  if (!adopted.adopted) {
    return { ok: false, reason: "owner-mismatch", scans: 0 };
  }

  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  let scans = 0;
  let emptyTargetScans = 0;
  let reason: RunLoopTeamMonitorResult["reason"];
  let diagnostics: string[] = [];
  let signalHandled = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (!ownsLoopTeamMonitor(root, token)) return;
    signalHandled = true;
    writeMonitorStatus(
      root,
      token,
      scans,
      true,
      "owner-lost",
      (deps.now ?? Date.now)(),
      [`received ${signal}`],
    );
    recordTeamMonitorEvent(
      root,
      {
        type: "monitor-signal",
        token,
        buildId: deps.buildId,
        message: signal,
        at: (deps.now ?? Date.now)(),
      },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
    releaseLoopTeamMonitorOwner(root, token);
  };
  const onSigterm = () => handleSignal("SIGTERM");
  const onSigint = () => handleSignal("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    while (true) {
      if (!ownsLoopTeamMonitor(root, token)) {
        reason = "owner-lost";
        break;
      }
      if (!isLoopModeActive(root)) {
        reason = "no-active-loop";
        break;
      }
      refreshLoopTeamMonitorHeartbeat(root, token, deps);
      const scan = deps.scan ??
        (async () => {
          const module = await import("./loop-monitor.js");
          return module.scanLoopTeamMonitorOnce(root, token);
        });
      const result = await scan();
      scans++;
      if (signalHandled || !ownsLoopTeamMonitor(root, token)) {
        reason = "owner-lost";
        break;
      }
      diagnostics = result.diagnostics;
      writeMonitorStatus(
        root,
        token,
        scans,
        false,
        "running",
        (deps.now ?? Date.now)(),
        diagnostics,
      );
      for (const message of diagnostics) {
        recordTeamMonitorEvent(
          root,
          { type: "scan-diagnostic", token, message, at: (deps.now ?? Date.now)() },
          TEAM_MONITOR_TIMING.retainedEvents,
        );
      }

      if (!isLoopModeActive(root)) {
        reason = "no-active-loop";
        break;
      }
      if (result.targetsScanned === 0) {
        emptyTargetScans += 1;
      } else {
        emptyTargetScans = 0;
      }
      if (
        emptyTargetScans >= TEAM_MONITOR_TIMING.noLiveTargetConsecutiveScanThreshold
      ) {
        reason = "no-live-targets";
        break;
      }
      if (deps.maxScans !== undefined && scans >= deps.maxScans) {
        reason = "max-scans";
        break;
      }
      await sleep(TEAM_MONITOR_TIMING.scanIntervalMs);
    }
  } catch (error) {
    reason = "error";
    diagnostics = [
      ...diagnostics,
      error instanceof Error ? error.message : String(error),
    ];
  }
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("SIGINT", onSigint);

  if (ownsLoopTeamMonitor(root, token)) {
    writeMonitorStatus(
      root,
      token,
      scans,
      true,
      reason,
      (deps.now ?? Date.now)(),
      diagnostics,
    );
    recordTeamMonitorEvent(
      root,
      {
        type: "monitor-terminal",
        token,
        buildId: deps.buildId,
        message: reason,
        at: (deps.now ?? Date.now)(),
      },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
    releaseLoopTeamMonitorOwner(root, token);
  }
  return {
    ok: reason === "no-active-loop" || reason === "no-live-targets" || reason === "max-scans",
    reason,
    scans,
  };
}

function pendingOwnerExpired(owner: MonitorOwner, now: number): boolean {
  if (owner.phase !== "pending") return false;
  const createdAt = Date.parse(owner.createdAt);
  return Number.isFinite(createdAt) && now - createdAt > TEAM_MONITOR_TIMING.pendingGraceMs;
}

function runningOwnerExpired(cwd: string, owner: MonitorOwner, now: number): boolean {
  if (owner.phase !== "running") return false;
  const ownerUpdatedAt = Date.parse(owner.updatedAt ?? "");
  if (Number.isFinite(ownerUpdatedAt)) {
    return now - ownerUpdatedAt > TEAM_MONITOR_TIMING.runningStaleMs;
  }
  const heartbeat = readMonitorHeartbeat(resolveTeamMonitorPaths(cwd).heartbeatFile);
  if (heartbeat?.token !== owner.token) return true;
  const lastHeartbeatAt = Date.parse(heartbeat.lastHeartbeatAt);
  return (
    !Number.isFinite(lastHeartbeatAt) ||
    now - lastHeartbeatAt > TEAM_MONITOR_TIMING.runningStaleMs
  );
}

function tryCreatePendingOwner(path: string, owner: MonitorOwner): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${JSON.stringify(owner)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function hasLiveRuntimeTarget(cwd: string): boolean {
  const teamRoot = statePath(cwd, "team");
  const entries = (() => {
    try {
      return readdirSync(teamRoot, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(teamRoot, entry.name);
    if (existsSync(join(root, "shutdown.json"))) continue;
    try {
      const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as TeamConfig;
      if (
        config.tmuxIdentity &&
        Array.isArray(config.workers) &&
        config.workers.some((worker) => Boolean(worker.paneId))
      ) {
        return true;
      }
    } catch {
      // A malformed team must not hide another healthy target.
    }
  }
  return false;
}

function hasLiveVisualTarget(cwd: string): boolean {
  const root = ompRoot(cwd);
  const visualDir = resolveTeamMonitorPaths(root).visualDir;
  const entries = (() => {
    try {
      return readdirSync(visualDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const registration = JSON.parse(
        readFileSync(join(visualDir, entry.name), "utf8"),
      ) as {
        schemaVersion?: number;
        projectRoot?: string;
        manifestPath?: string;
        panes?: unknown[];
      };
      if (
        registration.schemaVersion === 1 &&
        registration.projectRoot === root &&
        typeof registration.manifestPath === "string" &&
        existsSync(registration.manifestPath) &&
        Array.isArray(registration.panes) &&
        registration.panes.length > 0
      ) {
        return true;
      }
    } catch {
      // A malformed registration must not hide another healthy target.
    }
  }
  return false;
}

function defaultCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export function ensureLoopTeamMonitor(
  cwd: string,
  deps: EnsureLoopTeamMonitorDeps = {},
): EnsureLoopTeamMonitorResult {
  const root = ompRoot(cwd);
  if (!isLoopModeActive(root)) return { started: false, reason: "no-active-loop" };
  if (!hasLiveRuntimeTarget(root) && !hasLiveVisualTarget(root)) {
    return { started: false, reason: "no-live-targets" };
  }

  ensureTeamMonitorDirs(resolveTeamMonitorPaths(root));
  const now = (deps.now ?? Date.now)();
  const path = ownerPath(root);
  let existing = readOwner(path);
  if (!existing && existsSync(path)) {
    removeTokenFileIfMatches(path, readTokenFileToken(path));
    existing = readOwner(path);
  }
  const expired = existing
    ? pendingOwnerExpired(existing, now) || runningOwnerExpired(root, existing, now)
    : false;
  if (existing && !expired) {
    return {
      started: false,
      reason: existing.phase === "running" ? "already-running" : "already-pending",
    };
  }
  if (existing) {
    if (!releaseOwnerWithToken(path, existing.token)) {
      const winner = readOwner(path);
      return {
        started: false,
        reason: winner?.phase === "running" ? "already-running" : "already-pending",
      };
    }
    recordTeamMonitorEvent(
      root,
      {
        type: "owner-reclaimed",
        token: existing.token,
        message: existing.phase,
        at: now,
      },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
  }

  const token = (deps.token ?? randomUUID)();
  const pending: MonitorOwner = {
    schemaVersion: 1,
    token,
    phase: "pending",
    parentPid: deps.pid ?? process.pid,
    createdAt: new Date(now).toISOString(),
  };
  if (!tryCreatePendingOwner(path, pending)) {
    const winner = readOwner(path);
    return {
      started: false,
      reason: winner?.phase === "running" ? "already-running" : "already-pending",
    };
  }

  const spawn = deps.spawn ?? (nodeSpawn as unknown as MonitorSpawn);
  let child: MonitorChild;
  try {
    child = spawn(
      process.execPath,
      [
        deps.cliPath ?? defaultCliPath(),
        "team",
        "monitor-loop",
        "--root",
        root,
        "--token",
        token,
      ],
      { detached: true, stdio: "ignore" },
    );
  } catch (error) {
    releasePendingOwner(path, token);
    const message = error instanceof Error ? error.message : String(error);
    recordTeamMonitorEvent(
      root,
      { type: "spawn-failed", token, message, at: now },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
    return {
      started: false,
      reason: "spawn-failed",
      error: message,
    };
  }

  child.on?.("error", (error) => {
    if (!releasePendingOwner(path, token)) return;
    recordTeamMonitorEvent(
      root,
      {
        type: "child-error-before-heartbeat",
        token,
        message: error instanceof Error ? error.message : String(error),
      },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
  });
  child.on?.("exit", () => {
    if (!releasePendingOwner(path, token)) return;
    recordTeamMonitorEvent(
      root,
      { type: "child-exit-before-heartbeat", token },
      TEAM_MONITOR_TIMING.retainedEvents,
    );
  });
  child.unref?.();
  return { started: true, token };
}
