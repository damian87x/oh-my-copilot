import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "../utils/paths.js";

export type LoopMode = "ralph" | "ultrawork" | "ultraqa";
// State-file keys reusable by the typed path helpers. "ponytail" is a style
// mode (not a loop), so it is a state key but intentionally not a LoopMode and
// not counted by isLoopModeActive below.
export type ModeStateKey = LoopMode | "ponytail";

export function modeStatePath(cwd: string, mode: ModeStateKey): string {
  return statePath(cwd, `${mode}.json`);
}

function safePathPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "unknown";
}

function isLoopModeKey(mode: ModeStateKey): mode is LoopMode {
  return mode === "ralph" || mode === "ultrawork" || mode === "ultraqa";
}

export function agentStopLocksPath(cwd: string): string {
  return statePath(cwd, "locks");
}

export function clearAgentStopMarkers(cwd: string, mode: LoopMode): void {
  try {
    const locks = agentStopLocksPath(cwd);
    const prefix = `agentstop-${safePathPart(mode)}-`;
    for (const name of readdirSync(locks)) {
      if (name.startsWith(prefix)) unlinkSync(join(locks, name));
    }
  } catch {
    // best effort
  }
}

export function readModeStateJson<T>(cwd: string, mode: ModeStateKey): T | undefined {
  const p = modeStatePath(cwd, mode);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeModeStateJson<T>(cwd: string, mode: ModeStateKey, value: T): void {
  const p = modeStatePath(cwd, mode);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, p);
}

export function clearModeState(cwd: string, mode: ModeStateKey): void {
  const p = modeStatePath(cwd, mode);
  try {
    if (existsSync(p)) unlinkSync(p);
  } finally {
    if (isLoopModeKey(mode)) clearAgentStopMarkers(cwd, mode);
  }
}

/**
 * True when any loop mode (ralph/ultrawork/ultraqa) is currently active.
 * Single source of truth for mode-gated behaviour (e.g. team idle-nudge).
 * Pure, side-effect-free read.
 */
export function isLoopModeActive(cwd: string): boolean {
  const modes: LoopMode[] = ["ralph", "ultrawork", "ultraqa"];
  return modes.some((mode) => {
    const state = readModeStateJson<{ active?: boolean }>(cwd, mode);
    return state?.active === true;
  });
}
