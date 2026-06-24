import { clearModeState, readModeStateJson, writeModeStateJson } from "./paths.js";

export type PonytailLevel = "lite" | "full" | "ultra";

export interface PonytailState {
  active: boolean;
  level: PonytailLevel;
  startedAt: string;
  projectPath: string;
}

export function normalizeLevel(input?: string): PonytailLevel {
  const v = String(input ?? "").trim().toLowerCase();
  return v === "lite" || v === "ultra" ? v : "full";
}

export function startPonytail(cwd: string = process.cwd(), level?: string): PonytailState {
  const state: PonytailState = {
    active: true,
    level: normalizeLevel(level),
    startedAt: new Date().toISOString(),
    projectPath: cwd,
  };
  writeModeStateJson(cwd, "ponytail", state);
  return state;
}

export function readPonytail(cwd: string = process.cwd()): PonytailState | undefined {
  return readModeStateJson<PonytailState>(cwd, "ponytail");
}

export function cancelPonytail(cwd: string = process.cwd()): void {
  clearModeState(cwd, "ponytail");
}
