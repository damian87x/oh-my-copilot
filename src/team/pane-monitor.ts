import { makeTmux, paneHasActiveTask, paneLooksReady, sendToWorker, type TmuxApi } from "./tmux.js";

export interface PaneMonitorConfig {
  pollIntervalMs: number;
  readySamples: number;
  minObservationMs: number;
  timeoutMs: number;
  captureLines: number;
}

export const DEFAULT_PANE_MONITOR_CONFIG: PaneMonitorConfig = {
  pollIntervalMs: 3_000,
  readySamples: 2,
  minObservationMs: 10_000,
  timeoutMs: 30 * 60_000,
  captureLines: 120,
};

export interface PaneMonitorState {
  firstSeenAt: number;
  readyStreak: number;
  activeSeen: boolean;
  done: boolean;
}

export interface PaneAttentionEvent {
  paneId: string;
  kind: "ready" | "dead";
  message: string;
  at: number;
}

export interface PaneMonitorResult {
  ok: boolean;
  reason: "all-done" | "timeout";
  events: PaneAttentionEvent[];
}

export interface MonitorPanesOptions {
  leaderPaneId: string;
  workerPaneIds: string[];
  sessionLabel?: string;
  tmux?: TmuxApi;
  config?: Partial<PaneMonitorConfig>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paneLabel(sessionLabel: string | undefined, paneId: string): string {
  return sessionLabel ? `${sessionLabel} ${paneId}` : paneId;
}

export function createInitialPaneState(now: number): PaneMonitorState {
  return {
    firstSeenAt: now,
    readyStreak: 0,
    activeSeen: false,
    done: false,
  };
}

export function evaluatePaneState(
  state: PaneMonitorState,
  captured: string,
  paneDead: boolean,
  paneId: string,
  now: number,
  config: Pick<PaneMonitorConfig, "readySamples" | "minObservationMs">,
  sessionLabel?: string,
): { state: PaneMonitorState; event?: PaneAttentionEvent } {
  if (state.done) return { state };

  if (paneDead) {
    const event: PaneAttentionEvent = {
      paneId,
      kind: "dead",
      at: now,
      message: `team ${paneLabel(sessionLabel, paneId)} exited; review that pane`,
    };
    return {
      state: { ...state, done: true, readyStreak: 0 },
      event,
    };
  }

  const active = paneHasActiveTask(captured);
  const ready = paneLooksReady(captured) && !active;
  const observedLongEnough = now - state.firstSeenAt >= config.minObservationMs;

  if (active) {
    return {
      state: {
        ...state,
        activeSeen: true,
        readyStreak: 0,
      },
    };
  }

  if (!ready) {
    return {
      state: {
        ...state,
        readyStreak: 0,
      },
    };
  }

  const nextReadyStreak = state.readyStreak + 1;
  const shouldNotify = nextReadyStreak >= config.readySamples && (state.activeSeen || observedLongEnough);
  if (!shouldNotify) {
    return {
      state: {
        ...state,
        readyStreak: nextReadyStreak,
      },
    };
  }

  const event: PaneAttentionEvent = {
    paneId,
    kind: "ready",
    at: now,
    message: `team ${paneLabel(sessionLabel, paneId)} is ready for review`,
  };
  return {
    state: {
      ...state,
      readyStreak: nextReadyStreak,
      done: true,
    },
    event,
  };
}

export async function monitorPanes(opts: MonitorPanesOptions): Promise<PaneMonitorResult> {
  const tmux = opts.tmux ?? makeTmux();
  const config: PaneMonitorConfig = {
    pollIntervalMs: opts.config?.pollIntervalMs ?? DEFAULT_PANE_MONITOR_CONFIG.pollIntervalMs,
    readySamples: opts.config?.readySamples ?? DEFAULT_PANE_MONITOR_CONFIG.readySamples,
    minObservationMs: opts.config?.minObservationMs ?? DEFAULT_PANE_MONITOR_CONFIG.minObservationMs,
    timeoutMs: opts.config?.timeoutMs ?? DEFAULT_PANE_MONITOR_CONFIG.timeoutMs,
    captureLines: opts.config?.captureLines ?? DEFAULT_PANE_MONITOR_CONFIG.captureLines,
  };
  const states = new Map<string, PaneMonitorState>();
  const events: PaneAttentionEvent[] = [];

  const start = Date.now();
  for (const paneId of opts.workerPaneIds) {
    states.set(paneId, createInitialPaneState(start));
  }

  while (Date.now() - start < config.timeoutMs) {
    let remaining = 0;
    for (const paneId of opts.workerPaneIds) {
      const current = states.get(paneId);
      if (!current || current.done) continue;
      remaining++;
      const now = Date.now();
      const paneDead = tmux.paneDead(paneId);
      const captured = paneDead ? "" : tmux.capturePane(paneId, config.captureLines).stdout;
      const result = evaluatePaneState(current, captured, paneDead, paneId, now, config, opts.sessionLabel);
      states.set(paneId, result.state);
      if (result.event) {
        events.push(result.event);
        try {
          await sendToWorker(tmux, opts.leaderPaneId, result.event.message, { rounds: 4, delayMs: 100 });
        } catch {
          tmux.displayMessage(opts.leaderPaneId, result.event.message);
        }
        remaining--;
      }
    }

    if (remaining === 0) {
      return { ok: true, reason: "all-done", events };
    }

    await sleep(config.pollIntervalMs);
  }

  return { ok: false, reason: "timeout", events };
}
