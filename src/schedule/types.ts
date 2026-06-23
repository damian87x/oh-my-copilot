/** Default per-run timeout for a scheduled agent process (5 minutes). */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Default time-to-live for a scheduled job (3 days), matching Claude Code's expiry. */
export const DEFAULT_TTL_HOURS = 72;

/** Which OS scheduler owns the time trigger for a job. */
export type OsBackend = "launchd" | "systemd" | "crontab";

/** Terminal status of a single scheduled run. */
export type ScheduleRunStatus = "ok" | "error" | "timeout" | "locked" | "expired";

/**
 * Persisted scheduled job (`.omp/state/schedule/jobs/<id>.json`).
 * The portable source of truth; the OS-scheduler entry merely mirrors the trigger.
 */
export interface ScheduleJob {
  id: string;
  /** 5-field cron expression, interpreted in local time. */
  cron: string;
  prompt: string;
  /** Agent CLI to spawn. Resolved via resolveCopilotBin. */
  bin: string;
  model?: string;
  cwd: string;
  timeoutMs: number;
  /** When true, the agent is spawned with `--allow-all-tools` (unattended full access). */
  allowAllTools: boolean;
  createdAt: string;
  /** ISO timestamp after which the job auto-deactivates. */
  expiresAt?: string;
  maxRuns?: number;
  runCount: number;
  /** OS backend that owns this job's trigger (set at install time). */
  backend: OsBackend;
  ompBinPath: string;
  lastRunAt?: string;
  lastStatus?: ScheduleRunStatus;
  lastSummary?: string;
  lastLogPath?: string;
  active: boolean;
  /**
   * Optional outbound Slack target (`slack:C…`/`slack:G…`/`slack:D…`/`slack:U…`)
   * for end-of-run notification. When set, the runner calls
   * `gateway/notify.notify` with the run summary after each completed run.
   * Notify failures never fail the job — they're logged to stderr only.
   */
  notifyTarget?: string;
  /**
   * When true, fire a native desktop notification after each completed run
   * (independent of, and combinable with, notifyTarget). Best-effort: a failed
   * desktop notification is logged to stderr and never fails the job.
   */
  notifyDesktop?: boolean;
  /**
   * When true (and on macOS), the desktop notification's click action opens an
   * interactive `omp` session in the job's cwd instead of the raw run log. Has
   * no effect unless notifyDesktop is also set.
   */
  notifyOpenOmp?: boolean;
}

/** One line in `results/<id>.jsonl`. "Seen" state lives in the cursor, not here. */
export interface ScheduleRunResult {
  ts: string;
  exitCode: number;
  status: ScheduleRunStatus;
  summary: string;
  logPath: string;
  durationMs: number;
}

export interface ScheduleAddOptions {
  id: string;
  cron: string;
  prompt: string;
  bin?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  maxRuns?: number;
  ttlHours?: number;
  allowAllTools?: boolean;
  dryRun?: boolean;
  /** See ScheduleJob.notifyTarget. */
  notifyTarget?: string;
  /** See ScheduleJob.notifyDesktop. */
  notifyDesktop?: boolean;
  /** See ScheduleJob.notifyOpenOmp. */
  notifyOpenOmp?: boolean;
}
