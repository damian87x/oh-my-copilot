import { clearAgentStopMarkers, clearModeState, readModeStateJson, writeModeStateJson } from "./paths.js";

export interface UltraqaState {
  active: boolean;
  goal: string;
  cycleCount: number;
  maxCycles: number;
  startedAt: string;
  sessionId?: string;
  projectPath: string;
  lastVerdict?: "pass" | "fail" | "pending";
}

export interface StartUltraqaOptions {
  cwd?: string;
  goal: string;
  maxCycles?: number;
  sessionId?: string;
}

export function startUltraqa(opts: StartUltraqaOptions): UltraqaState {
  const cwd = opts.cwd ?? process.cwd();
  clearAgentStopMarkers(cwd, "ultraqa");
  const state: UltraqaState = {
    active: true,
    goal: opts.goal,
    cycleCount: 0,
    maxCycles: opts.maxCycles ?? 5,
    startedAt: new Date().toISOString(),
    sessionId: opts.sessionId,
    projectPath: cwd,
    lastVerdict: "pending",
  };
  writeModeStateJson(cwd, "ultraqa", state);
  return state;
}

export function readUltraqa(cwd: string = process.cwd()): UltraqaState | undefined {
  return readModeStateJson<UltraqaState>(cwd, "ultraqa");
}

export function cancelUltraqa(cwd: string = process.cwd()): void {
  clearModeState(cwd, "ultraqa");
}

export interface UltraqaCycleResult {
  ok: boolean;
  state?: UltraqaState;
  reason?: string;
}

export function recordUltraqaCycle(
  cwd: string = process.cwd(),
  verdict: "pass" | "fail" | "pending",
): UltraqaCycleResult {
  const state = readUltraqa(cwd);
  if (!state) return { ok: false, reason: "not active" };
  const next: UltraqaState = {
    ...state,
    cycleCount: state.cycleCount + 1,
    lastVerdict: verdict,
  };
  if (verdict === "pass") {
    cancelUltraqa(cwd);
    return { ok: true, state: { ...next, active: false } };
  }
  if (next.cycleCount >= state.maxCycles) {
    cancelUltraqa(cwd);
    return { ok: false, state: { ...next, active: false }, reason: `max cycles (${state.maxCycles}) reached` };
  }
  writeModeStateJson(cwd, "ultraqa", next);
  return { ok: true, state: next };
}

export function buildUltraqaContext(state: UltraqaState): string {
  return [
    `[ULTRAQA ACTIVE: cycle ${state.cycleCount}/${state.maxCycles}]`,
    `Goal: ${state.goal}`,
    `Last verdict: ${state.lastVerdict ?? "pending"}`,
    "Run tests → verify → fix. Iterate until the goal passes.",
  ].join("\n");
}
