import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LoopMode = "ralph" | "ultrawork" | "ultraqa";

export function modeStatePath(cwd: string, mode: LoopMode): string {
  return join(resolve(cwd), ".omp", "state", `${mode}.json`);
}

export function readModeStateJson<T>(cwd: string, mode: LoopMode): T | undefined {
  const p = modeStatePath(cwd, mode);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function writeModeStateJson<T>(cwd: string, mode: LoopMode, value: T): void {
  const p = modeStatePath(cwd, mode);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, p);
}

export function clearModeState(cwd: string, mode: LoopMode): void {
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
