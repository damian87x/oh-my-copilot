import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { getInstalledStatus, installJob, uninstallJob } from "./installer.js";
import { deleteJob, listJobs, readJob, writeJob } from "./job-store.js";
import {
  ensureScheduleDirs,
  jobFilePath,
  jobLockPath,
  resolveSchedulePaths,
} from "./paths.js";
import { runScheduledJob } from "./runner.js";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_HOURS,
  type OsBackend,
  type ScheduleAddOptions,
  type ScheduleJob,
} from "./types.js";

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/; // exactly 5 whitespace-separated fields

export function validateScheduleId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Resolve the absolute path of the `omp` wrapper to write into OS entries.
 * The dist `.js` (process.argv[1]) is a last resort because launchd/cron need
 * the executable wrapper, not the script.
 */
export function resolveOmpBinPath(): string {
  const fromEnv = process.env.OMP_BIN;
  if (fromEnv) return fromEnv;
  try {
    const which = execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
    if (which) return which;
  } catch {
    // not on PATH
  }
  return process.argv[1] ?? "omp";
}

export interface AddResult {
  ok: boolean;
  job?: ScheduleJob;
  backend?: OsBackend;
  messages: string[];
  error?: string;
}

export function addScheduleJob(stateCwd: string, opts: ScheduleAddOptions): AddResult {
  const messages: string[] = [];
  if (!validateScheduleId(opts.id)) {
    return { ok: false, messages, error: `invalid --id "${opts.id}" (use letters, digits, _ or -)` };
  }
  if (!CRON_RE.test(opts.cron)) {
    return { ok: false, messages, error: `invalid --cron "${opts.cron}" (expected 5 fields)` };
  }
  const agentCwd = opts.cwd ?? stateCwd;
  if (!existsSync(agentCwd) || !statSync(agentCwd).isDirectory()) {
    return { ok: false, messages, error: `--cwd does not exist or is not a directory: ${agentCwd}` };
  }

  const paths = resolveSchedulePaths(stateCwd);
  ensureScheduleDirs(paths);
  const allowAllTools = opts.allowAllTools ?? false;
  // TTL precedence: explicit --ttl-hours wins; else a --max-runs-only job has no
  // TTL (run-count bounds it); else fall back to the default 72h TTL.
  const expiresAt =
    opts.ttlHours !== undefined
      ? new Date(Date.now() + opts.ttlHours * 3_600_000).toISOString()
      : opts.maxRuns !== undefined
        ? undefined
        : new Date(Date.now() + DEFAULT_TTL_HOURS * 3_600_000).toISOString();
  const job: ScheduleJob = {
    id: opts.id,
    cron: opts.cron,
    prompt: opts.prompt,
    bin: opts.bin ?? "copilot",
    model: opts.model,
    cwd: agentCwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    allowAllTools,
    createdAt: new Date().toISOString(),
    expiresAt,
    maxRuns: opts.maxRuns,
    runCount: 0,
    backend: "crontab",
    ompBinPath: resolveOmpBinPath(),
    active: true,
    notifyTarget: opts.notifyTarget,
    notifyDesktop: opts.notifyDesktop ?? false,
    notifyOpenOmp: opts.notifyOpenOmp ?? false,
  };

  if (opts.dryRun) {
    messages.push(`[dry-run] would install job "${job.id}" (cron ${job.cron}) for agent ${job.bin} in ${job.cwd}`);
    return { ok: true, job, messages };
  }

  // Clean replace: if a job with this id already exists, uninstall its OS entry by
  // the RECORDED backend first. The new install's detected backend may differ (e.g.
  // a prior crontab-fallback re-added with a simple cron resolves to launchd), which
  // would otherwise orphan the old entry.
  const existing = readJob(jobFilePath(paths.jobsDir, job.id));
  if (existing) uninstallJob(existing.id, existing.backend);

  writeJob(jobFilePath(paths.jobsDir, job.id), job);
  const result = installJob(job, paths.logsDir, paths.cwd);
  job.backend = result.backend;
  writeJob(jobFilePath(paths.jobsDir, job.id), job); // persist resolved backend

  messages.push(`scheduled "${job.id}" via ${job.backend} (cron ${job.cron})`);
  if (allowAllTools) {
    messages.push(
      `⚠ WARNING: "${job.id}" runs UNATTENDED with full tool access (--allow-all-tools) in ${job.cwd}. Ensure the prompt is safe.`,
    );
  } else {
    messages.push(
      `note: "${job.id}" runs without --allow-all-tools, so in unattended (-p, no TTY) mode the agent is limited to read-only/allowlisted tools. Re-add with --allow-all-tools if it must act.`,
    );
  }
  return { ok: true, job, backend: job.backend, messages };
}

export interface JobView extends ScheduleJob {
  osInstalled: boolean;
}

export function listScheduleJobs(stateCwd: string): JobView[] {
  const paths = resolveSchedulePaths(stateCwd);
  return listJobs(paths.jobsDir).map((job) => ({ ...job, osInstalled: getInstalledStatus(job.id, job.backend) }));
}

export interface RemoveResult {
  removed: boolean;
  uninstalled: boolean;
}

export function removeScheduleJob(stateCwd: string, id: string): RemoveResult {
  const paths = resolveSchedulePaths(stateCwd);
  const jobPath = jobFilePath(paths.jobsDir, id);
  const job = readJob(jobPath);
  if (!job) return { removed: false, uninstalled: false };
  uninstallJob(id, job.backend);
  deleteJob(jobPath);
  try {
    unlinkSync(jobLockPath(paths.jobsDir, id));
  } catch {
    // no lock to clean
  }
  // results + logs are intentionally preserved for audit
  return { removed: true, uninstalled: true };
}

export interface StatusView {
  job?: ScheduleJob;
  osInstalled: boolean;
}

export function getScheduleStatus(stateCwd: string, id: string): StatusView {
  const paths = resolveSchedulePaths(stateCwd);
  const job = readJob(jobFilePath(paths.jobsDir, id));
  return { job, osInstalled: job ? getInstalledStatus(id, job.backend) : false };
}

export interface OpenResult {
  ok: boolean;
  job?: ScheduleJob;
  /** Full captured output of the latest run (contents of job.lastLogPath), if present. */
  logContent?: string;
  error?: string;
}

/**
 * Resolve a job's latest run for `omp schedule open <id>` — the by-id substitute
 * for clicking a notification: returns the job plus the full captured log so the
 * caller can surface the latest scan with full context. Read-only; never throws.
 */
export function openScheduleResult(stateCwd: string, id: string): OpenResult {
  const paths = resolveSchedulePaths(stateCwd);
  const job = readJob(jobFilePath(paths.jobsDir, id));
  if (!job) return { ok: false, error: `no schedule job "${id}"` };
  let logContent: string | undefined;
  if (job.lastLogPath && existsSync(job.lastLogPath)) {
    try {
      logContent = readFileSync(job.lastLogPath, "utf8");
    } catch {
      // log unreadable — still return the job metadata
    }
  }
  return { ok: true, job, logContent };
}

/** Run handler entry used by `omp schedule run|run-now`. Missing job → clean no-op (exit 0). */
export async function runScheduleById(stateCwd: string, id: string): Promise<{ ok: boolean; message: string }> {
  const paths = resolveSchedulePaths(stateCwd);
  const job = readJob(jobFilePath(paths.jobsDir, id));
  if (!job) {
    return { ok: true, message: `schedule run: job "${id}" not found (orphan OS entry?); no-op` };
  }
  const result = await runScheduledJob(job, paths, {
    onExpire: (j) => uninstallJob(j.id, j.backend),
  });
  return { ok: result.status !== "error", message: `run "${id}" → ${result.status}: ${result.summary}` };
}
