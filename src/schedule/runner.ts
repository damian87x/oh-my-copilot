import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCopilotBin } from "../copilot/launch.js";
import { appendRunResult, readJob, writeJob } from "./job-store.js";
import { acquireLock, forceReleaseStaleLock, isLockStale } from "./lock.js";
import { jobFilePath, jobLockPath, resultsFilePath, runLogDir, type SchedulePaths } from "./paths.js";
import { DEFAULT_TIMEOUT_MS, type ScheduleJob, type ScheduleRunResult, type ScheduleRunStatus } from "./types.js";

export interface RunOptions {
  /** Called when a job has expired (TTL passed or maxRuns reached) so the caller can uninstall the OS entry. */
  onExpire?: (job: ScheduleJob) => void;
}

function isExpired(job: ScheduleJob): boolean {
  if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) return true;
  if (job.expiresAt && Date.now() > Date.parse(job.expiresAt)) return true;
  return false;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Keep only the newest `keep` per-run logs in a job's log dir (timestamp slugs sort chronologically). */
function rotateLogs(logDir: string, keep = 50): void {
  if (!existsSync(logDir)) return;
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      unlinkSync(join(logDir, f));
    } catch {
      // best effort
    }
  }
}

/** Execute one scheduled run (expiry check, overlap lock, timeout, log capture, result append). */
export async function runScheduledJob(
  job: ScheduleJob,
  paths: SchedulePaths,
  opts: RunOptions = {},
): Promise<ScheduleRunResult> {
  const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobPath = jobFilePath(paths.jobsDir, job.id);
  const resultsPath = resultsFilePath(paths.resultsDir, job.id);

  const persist = (status: ScheduleRunStatus, result: ScheduleRunResult, incrementRun: boolean): void => {
    appendRunResult(resultsPath, result);
    const current = readJob(jobPath) ?? job;
    writeJob(jobPath, {
      ...current,
      runCount: incrementRun ? current.runCount + 1 : current.runCount,
      lastRunAt: result.ts,
      lastStatus: status,
      lastSummary: result.summary,
      lastLogPath: result.logPath,
      active: status === "expired" ? false : current.active,
    });
  };

  // 1. Expiry / max-runs check BEFORE any spawn.
  if (isExpired(job)) {
    const result: ScheduleRunResult = {
      ts: new Date().toISOString(),
      exitCode: 0,
      status: "expired",
      summary: "job expired (TTL or max-runs reached); deactivated",
      logPath: "",
      durationMs: 0,
    };
    persist("expired", result, false);
    opts.onExpire?.(job);
    return result;
  }

  // 2. Overlap lock.
  const lockPath = jobLockPath(paths.jobsDir, job.id);
  forceReleaseStaleLock(lockPath, timeoutMs);
  let lock = acquireLock(lockPath);
  if (!lock.acquired) {
    if (isLockStale(lockPath, timeoutMs)) {
      forceReleaseStaleLock(lockPath, timeoutMs);
      lock = acquireLock(lockPath);
    }
  }
  if (!lock.acquired) {
    const result: ScheduleRunResult = {
      ts: new Date().toISOString(),
      exitCode: -1,
      status: "locked",
      summary: "previous run still in progress; skipped",
      logPath: "",
      durationMs: 0,
    };
    appendRunResult(resultsPath, result);
    return result;
  }

  // 3. Spawn the agent and capture output.
  const startedAt = Date.now();
  const logDir = runLogDir(paths.logsDir, job.id);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${timestampSlug()}.log`);

  try {
    const bin = resolveCopilotBin(job.bin);
    const args: string[] = [];
    if (job.model) args.push("--model", job.model);
    args.push("-p", job.prompt);
    if (job.allowAllTools) args.push("--allow-all-tools");

    const result = await new Promise<ScheduleRunResult>((resolveFn) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], cwd: job.cwd });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Escalate to SIGKILL if the child ignores SIGTERM, so a run can't hang forever.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeoutMs);

      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        writeFileSync(logPath, `$ ${bin} ${args.join(" ")}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}\n`, "utf8");
        rotateLogs(logDir);
        const status: ScheduleRunStatus = timedOut ? "timeout" : exitCode === 0 ? "ok" : "error";
        const summarySource = (stdout.trim() || stderr.trim()).replace(/\s+/g, " ");
        resolveFn({
          ts: new Date().toISOString(),
          exitCode,
          status,
          summary: summarySource.slice(0, 200) || `exit ${exitCode}`,
          logPath,
          durationMs: Date.now() - startedAt,
        });
      };

      child.on("error", () => finish(127));
      child.on("close", (code) => finish(typeof code === "number" ? code : timedOut ? 124 : 1));
    });

    persist(result.status, result, true);
    return result;
  } finally {
    lock.release();
  }
}
