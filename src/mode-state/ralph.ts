import { clearModeState, readModeStateJson, writeModeStateJson } from "./paths.js";

export interface RalphState {
  active: boolean;
  iteration: number;
  maxIterations: number;
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
  const state: RalphState = {
    active: true,
    iteration: 0,
    maxIterations: opts.maxIterations ?? 10,
    startedAt: new Date().toISOString(),
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    projectPath: cwd,
  };
  writeModeStateJson(cwd, "ralph", state);
  return state;
}

export function readRalph(cwd: string = process.cwd()): RalphState | undefined {
  return readModeStateJson<RalphState>(cwd, "ralph");
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
  if (state.iteration >= state.maxIterations) {
    cancelRalph(cwd);
    return { ok: false, reason: `max iterations (${state.maxIterations}) reached` };
  }
  const advanced: RalphState = { ...state, iteration: state.iteration + 1 };
  writeModeStateJson(cwd, "ralph", advanced);
  return { ok: true, state: advanced };
}

export function buildRalphContext(state: RalphState): string {
  return [
    `[RALPH ACTIVE: iteration ${state.iteration}/${state.maxIterations}]`,
    `Started: ${state.startedAt}`,
    `Prompt: ${state.prompt}`,
    "Continue the loop. Report concrete progress.",
  ].join("\n");
}
