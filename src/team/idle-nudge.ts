import { paneHasActiveTask, paneLooksReady, sendToWorker, type TmuxApi } from "./tmux.js";

export interface NudgeConfig {
  delayMs: number;
  maxCount: number;
  scanIntervalMs: number;
  message: string;
}

export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  delayMs: 30_000,
  maxCount: 3,
  scanIntervalMs: 5_000,
  message: "Continue working on your assigned task and report concrete progress (not ACK-only).",
};

interface PaneNudgeState {
  nudgeCount: number;
  firstIdleAt: number | null;
  lastNudgeAt: number | null;
}

export interface NudgeSummaryEntry {
  paneId: string;
  nudgeCount: number;
  lastNudgeAt: number | null;
}

export interface NudgeAttempt {
  paneId: string;
  nudgeCount: number;
  at: number;
}

export class NudgeTracker {
  private readonly config: NudgeConfig;
  private readonly states = new Map<string, PaneNudgeState>();
  private lastScanAt = 0;

  constructor(config: Partial<NudgeConfig> = {}) {
    this.config = { ...DEFAULT_NUDGE_CONFIG, ...config };
  }

  async checkAndNudge(
    api: TmuxApi,
    sessionName: string,
    panes: string[],
    leaderPaneId?: string,
    now: number = Date.now(),
  ): Promise<NudgeAttempt[]> {
    if (now - this.lastScanAt < this.config.scanIntervalMs) return [];
    this.lastScanAt = now;
    const attempts: NudgeAttempt[] = [];

    for (const paneId of panes) {
      if (paneId === leaderPaneId) continue;
      let state = this.states.get(paneId);
      if (!state) {
        state = { nudgeCount: 0, firstIdleAt: null, lastNudgeAt: null };
        this.states.set(paneId, state);
      }
      if (state.nudgeCount >= this.config.maxCount) continue;

      const captured = api.capturePane(paneId, 80).stdout;
      const idle = paneLooksReady(captured) && !paneHasActiveTask(captured);
      if (!idle) {
        state.firstIdleAt = null;
        continue;
      }

      if (state.firstIdleAt === null) state.firstIdleAt = now;
      if (now - state.firstIdleAt < this.config.delayMs) continue;

      const sent = await sendToWorker(api, paneId, this.config.message, { rounds: 4, delayMs: 100 });
      if (sent) {
        state.nudgeCount++;
        state.lastNudgeAt = now;
        state.firstIdleAt = null;
        attempts.push({ paneId, nudgeCount: state.nudgeCount, at: now });
      }
    }
    return attempts;
  }

  getSummary(): NudgeSummaryEntry[] {
    return Array.from(this.states.entries())
      .filter(([, s]) => s.nudgeCount > 0)
      .map(([paneId, s]) => ({ paneId, nudgeCount: s.nudgeCount, lastNudgeAt: s.lastNudgeAt }));
  }

  reset(): void {
    this.states.clear();
    this.lastScanAt = 0;
  }
}
