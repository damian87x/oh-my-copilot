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

export function buildPonytailContext(state: PonytailState): string {
  const ladder =
    "1 needed at all? (YAGNI) 2 already here? reuse 3 stdlib? use it " +
    "4 native platform? use it 5 installed dep? use it 6 one line? one line " +
    "7 only then the minimum that works";
  return [
    `[PONYTAIL ACTIVE: ${state.level}]`,
    "Lazy senior dev mode. Stop at the first rung that holds, after understanding the problem:",
    ladder + ".",
    "Never lazy about: validation at trust boundaries, data-loss handling, security, accessibility, anything requested. Non-trivial logic leaves one runnable check behind.",
  ].join("\n");
}
