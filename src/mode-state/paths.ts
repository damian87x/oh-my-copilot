import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../utils/paths.js";

export type LoopMode = "ralph" | "ultrawork" | "ultraqa";
// State-file keys reusable by the typed path helpers. "ponytail" is a style
// mode (not a loop), so it is a state key but intentionally not a LoopMode and
// not counted by isLoopModeActive below.
export type ModeStateKey = LoopMode | "ponytail";

export function modeStatePath(cwd: string, mode: ModeStateKey): string {
  return statePath(cwd, `${mode}.json`);
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
  if (existsSync(p)) unlinkSync(p);
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
