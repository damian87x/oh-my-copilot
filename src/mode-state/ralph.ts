import { clearAgentStopMarkers, clearModeState, readModeStateJson, writeModeStateJson } from "./paths.js";

export interface RalphState {
  active: boolean;
  iteration: number;
  maxIterations: number;
  completedSlices: number;
  startedAt: string;
  prompt: string;
  sessionId?: string;
  projectPath: string;
}

export interface StartRalphOptions {
  cwd?: string;
  prompt: string;
  sessionId?: string;
  maxIterations?: number;
}

export function startRalph(opts: StartRalphOptions): RalphState {
  const cwd = opts.cwd ?? process.cwd();
  clearAgentStopMarkers(cwd, "ralph");
  const state: RalphState = {
    active: true,
    iteration: 0,
    maxIterations: opts.maxIterations ?? 10,
    completedSlices: 0,
    startedAt: new Date().toISOString(),
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    projectPath: cwd,
  };
  writeModeStateJson(cwd, "ralph", state);
  return state;
}

export function readRalph(cwd: string = process.cwd()): RalphState | undefined {
  const state = readModeStateJson<RalphState>(cwd, "ralph");
  return state ? { ...state, completedSlices: state.completedSlices ?? 0 } : undefined;
}

export function cancelRalph(cwd: string = process.cwd()): void {
  clearModeState(cwd, "ralph");
}

export interface RalphTickResult {
  ok: boolean;
  state?: RalphState;
  reason?: string;
}

export function tickRalph(cwd: string = process.cwd()): RalphTickResult {
  const state = readRalph(cwd);
  if (!state) return { ok: false, reason: "not active" };
  if (!state.active) return { ok: false, reason: "loop already cleared" };
  const advanced: RalphState = { ...state, completedSlices: (state.completedSlices ?? 0) + 1 };
  writeModeStateJson(cwd, "ralph", advanced);
  return { ok: true, state: advanced };
}

export function buildRalphContext(state: RalphState): string {
  return [
    `[RALPH ACTIVE: iteration ${state.iteration}/${state.maxIterations}]`,
    `Completed slices: ${state.completedSlices ?? 0}`,
    `Started: ${state.startedAt}`,
    `Prompt: ${state.prompt}`,
    "Continue the loop. Report concrete progress.",
  ].join("\n");
}
