import { clearAgentStopMarkers, clearModeState, readModeStateJson, writeModeStateJson } from "./paths.js";

export interface UltraworkState {
  active: boolean;
  objective: string;
  taskSummary?: string;
  startedAt: string;
  sessionId?: string;
  projectPath: string;
  taskCount: number;
}

export interface StartUltraworkOptions {
  cwd?: string;
  objective: string;
  taskSummary?: string;
  sessionId?: string;
  taskCount?: number;
}

export function startUltrawork(opts: StartUltraworkOptions): UltraworkState {
  const cwd = opts.cwd ?? process.cwd();
  clearAgentStopMarkers(cwd, "ultrawork");
  const state: UltraworkState = {
    active: true,
    objective: opts.objective,
    taskSummary: opts.taskSummary,
    startedAt: new Date().toISOString(),
    sessionId: opts.sessionId,
    projectPath: cwd,
    taskCount: opts.taskCount ?? 0,
  };
  writeModeStateJson(cwd, "ultrawork", state);
  return state;
}

export function readUltrawork(cwd: string = process.cwd()): UltraworkState | undefined {
  return readModeStateJson<UltraworkState>(cwd, "ultrawork");
}

export function cancelUltrawork(cwd: string = process.cwd()): void {
  clearModeState(cwd, "ultrawork");
}

export function buildUltraworkContext(state: UltraworkState): string {
  return [
    "[ULTRAWORK ACTIVE]",
    `Objective: ${state.objective}`,
    `Started: ${state.startedAt}`,
    `Tasks: ${state.taskCount}`,
    state.taskSummary ? `Summary: ${state.taskSummary}` : "",
    "Sustain the objective. Batch parallel tasks. Report progress per todo.",
  ]
    .filter(Boolean)
    .join("\n");
}
