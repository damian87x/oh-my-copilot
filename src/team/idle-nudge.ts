import { randomUUID } from "node:crypto";
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
  revision: number;
  nudgeCount: number;
  firstIdleAt: number | null;
  lastNudgeAt: number | null;
  lastAttempt?: PersistedNudgeAttempt;
}

export type NudgeOutcome = "reserved" | "sent" | "failed" | "skipped";

export interface PersistedNudgeAttempt {
  attemptId: string;
  reservedAt: number;
  outcome: NudgeOutcome;
  completedAt?: number;
}

export interface PaneNudgeSnapshot extends PaneNudgeState {
  paneId: string;
}

export interface NudgeTrackerSnapshot {
  schemaVersion: 1;
  lastScanAt: number;
  panes: PaneNudgeSnapshot[];
}

export interface NudgeSummaryEntry {
  paneId: string;
  nudgeCount: number;
  lastNudgeAt: number | null;
}

export interface NudgeAttempt {
  paneId: string;
  attemptId: string;
  nudgeCount: number;
  at: number;
  outcome: Exclude<NudgeOutcome, "reserved">;
}

export interface NudgeCandidate {
  paneId: string;
  at: number;
}

export class NudgeTracker {
  private readonly config: NudgeConfig;
  private readonly states = new Map<string, PaneNudgeState>();
  private lastScanAt = 0;

  constructor(
    config: Partial<NudgeConfig> = {},
    snapshot?: NudgeTrackerSnapshot,
  ) {
    this.config = { ...DEFAULT_NUDGE_CONFIG, ...config };
    if (snapshot?.schemaVersion === 1) {
      this.lastScanAt = snapshot.lastScanAt;
      for (const pane of snapshot.panes) {
        this.states.set(pane.paneId, {
          revision: pane.revision,
          nudgeCount: pane.nudgeCount,
          firstIdleAt: pane.firstIdleAt,
          lastNudgeAt: pane.lastNudgeAt,
          lastAttempt: pane.lastAttempt ? { ...pane.lastAttempt } : undefined,
        });
      }
    }
  }

  observePanes(
    api: TmuxApi,
    panes: string[],
    leaderPaneId?: string,
    now: number = Date.now(),
  ): NudgeCandidate[] {
    if (now - this.lastScanAt < this.config.scanIntervalMs) return [];
    this.lastScanAt = now;
    const due: NudgeCandidate[] = [];

    for (const paneId of panes) {
      if (paneId === leaderPaneId) continue;
      let state = this.states.get(paneId);
      if (!state) {
        state = { revision: 0, nudgeCount: 0, firstIdleAt: null, lastNudgeAt: null };
        this.states.set(paneId, state);
      }
      if (state.nudgeCount >= this.config.maxCount) continue;

      const captured = api.capturePane(paneId, 80).stdout;
      const idle = paneLooksReady(captured) && !paneHasActiveTask(captured);
      if (!idle) {
        if (state.firstIdleAt !== null) {
          state.firstIdleAt = null;
          state.revision++;
        }
        continue;
      }

      if (state.firstIdleAt === null) {
        state.firstIdleAt = now;
        state.revision++;
      }
      if (now - state.firstIdleAt >= this.config.delayMs) {
        due.push({ paneId, at: now });
      }
    }
    return due;
  }

  reserveNudge(
    paneId: string,
    attemptId: string,
    now: number = Date.now(),
  ): Omit<NudgeAttempt, "outcome"> | undefined {
    const state = this.states.get(paneId);
    if (
      !state ||
      state.nudgeCount >= this.config.maxCount ||
      state.firstIdleAt === null ||
      now - state.firstIdleAt < this.config.delayMs
    ) {
      return undefined;
    }
    state.nudgeCount++;
    state.lastNudgeAt = now;
    state.firstIdleAt = null;
    state.lastAttempt = {
      attemptId,
      reservedAt: now,
      outcome: "reserved",
    };
    state.revision++;
    return { paneId, attemptId, nudgeCount: state.nudgeCount, at: now };
  }

  recordNudgeOutcome(
    paneId: string,
    attemptId: string,
    outcome: Exclude<NudgeOutcome, "reserved">,
    completedAt: number = Date.now(),
  ): boolean {
    const state = this.states.get(paneId);
    if (!state?.lastAttempt || state.lastAttempt.attemptId !== attemptId) return false;
    state.lastAttempt = {
      ...state.lastAttempt,
      outcome,
      completedAt,
    };
    state.revision++;
    return true;
  }

  async checkAndNudge(
    api: TmuxApi,
    sessionName: string,
    panes: string[],
    leaderPaneId?: string,
    now: number = Date.now(),
  ): Promise<NudgeAttempt[]> {
    const attempts: NudgeAttempt[] = [];
    for (const candidate of this.observePanes(api, panes, leaderPaneId, now)) {
      const attemptId = randomUUID();
      const reservation = this.reserveNudge(candidate.paneId, attemptId, now);
      if (!reservation) continue;
      let sent: boolean;
      try {
        sent = await sendToWorker(api, candidate.paneId, this.config.message, {
          rounds: 4,
          delayMs: 100,
        });
      } catch {
        sent = false;
      }
      const outcome = sent ? "sent" : "failed";
      this.recordNudgeOutcome(candidate.paneId, attemptId, outcome, now);
      attempts.push({ ...reservation, outcome });
    }
    return attempts;
  }

  getSummary(): NudgeSummaryEntry[] {
    return Array.from(this.states.entries())
      .filter(([, s]) => s.nudgeCount > 0)
      .map(([paneId, s]) => ({ paneId, nudgeCount: s.nudgeCount, lastNudgeAt: s.lastNudgeAt }));
  }

  snapshot(): NudgeTrackerSnapshot {
    return {
      schemaVersion: 1,
      lastScanAt: this.lastScanAt,
      panes: Array.from(this.states.entries())
        .map(([paneId, state]) => ({ paneId, ...state }))
        .sort((left, right) => left.paneId.localeCompare(right.paneId)),
    };
  }

  reset(): void {
    this.states.clear();
    this.lastScanAt = 0;
  }
}
