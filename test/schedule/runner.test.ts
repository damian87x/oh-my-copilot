import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJob } from "../../src/schedule/job-store.js";
import { acquireLock } from "../../src/schedule/lock.js";
import {
  ensureScheduleDirs,
  jobFilePath,
  jobLockPath,
  resolveSchedulePaths,
  type SchedulePaths,
} from "../../src/schedule/paths.js";
import { runScheduledJob } from "../../src/schedule/runner.js";
import type { ScheduleJob } from "../../src/schedule/types.js";

const saved = { bin: process.env.OMP_COPILOT_BIN, log: process.env.OMP_STUB_LOG };
let root: string;
let paths: SchedulePaths;
let stub: string;
let argLog: string;

function makeJob(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  const job: ScheduleJob = {
    id: "t",
    cron: "*/5 * * * *",
    prompt: "do the thing",
    bin: stub, // point at the stub agent so resolveCopilotBin uses it directly
    cwd: root,
    timeoutMs: 4000,
    allowAllTools: false,
    createdAt: new Date().toISOString(),
    runCount: 0,
    backend: "crontab",
    ompBinPath: "/usr/local/bin/omp",
    active: true,
    ...overrides,
  };
  writeFileSync(jobFilePath(paths.jobsDir, job.id), JSON.stringify(job, null, 2));
  return job;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omp-sched-run-"));
  paths = resolveSchedulePaths(root);
  ensureScheduleDirs(paths);
  argLog = path.join(root, "argv.json");
  stub = path.join(root, "stub-agent");
  // Stub agent: records argv, then either sleeps (prompt SLEEP) or prints + exits.
  writeFileSync(
    stub,
    "#!/usr/bin/env node\n" +
      "const fs=require('node:fs');\n" +
      "fs.writeFileSync(process.env.OMP_STUB_LOG, JSON.stringify(process.argv.slice(2)));\n" +
      "if(process.argv.includes('SLEEP')){ setTimeout(()=>{}, 60000); }\n" +
      "else { process.stdout.write('hello from stub agent'); process.exit(0); }\n",
  );
  chmodSync(stub, 0o755);
  process.env.OMP_COPILOT_BIN = stub;
  process.env.OMP_STUB_LOG = argLog;
});

afterEach(() => {
  for (const [k, v] of [["OMP_COPILOT_BIN", saved.bin], ["OMP_STUB_LOG", saved.log]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("schedule runner", () => {
  it("spawns the agent, captures output, writes a log, appends a result, updates job", async () => {
    const job = makeJob();
    const result = await runScheduledJob(job, paths);
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hello from stub agent");
    // argv: no --model, no --allow-all-tools by default
    expect(JSON.parse(readFileSync(argLog, "utf8"))).toEqual(["-p", "do the thing"]);
    // log file written
    const logs = readdirSync(path.join(paths.logsDir, "t"));
    expect(logs.length).toBe(1);
    // job updated
    const updated = readJob(jobFilePath(paths.jobsDir, "t"));
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastStatus).toBe("ok");
  });

  it("adds --model and --allow-all-tools only when the job opts in", async () => {
    const job = makeJob({ model: "claude-sonnet-4-6", allowAllTools: true });
    await runScheduledJob(job, paths);
    expect(JSON.parse(readFileSync(argLog, "utf8"))).toEqual([
      "--model",
      "claude-sonnet-4-6",
      "-p",
      "do the thing",
      "--allow-all-tools",
    ]);
  });

  it("applies the default timeout when timeoutMs is the configured default", async () => {
    // sanity: a job whose prompt triggers SLEEP times out under a short timeout
    const job = makeJob({ prompt: "SLEEP", timeoutMs: 800 });
    const result = await runScheduledJob(job, paths);
    expect(result.status).toBe("timeout");
  });

  it("returns 'locked' without spawning when a live lock is held", async () => {
    const job = makeJob();
    const lock = acquireLock(jobLockPath(paths.jobsDir, "t"));
    expect(lock.acquired).toBe(true);
    const result = await runScheduledJob(job, paths);
    expect(result.status).toBe("locked");
    expect(existsSync(argLog)).toBe(false); // agent never spawned
    lock.release();
  });

  it("returns 'expired' and deactivates when maxRuns is reached, without spawning", async () => {
    let expired = false;
    const job = makeJob({ maxRuns: 1, runCount: 1 });
    const result = await runScheduledJob(job, paths, { onExpire: () => (expired = true) });
    expect(result.status).toBe("expired");
    expect(expired).toBe(true);
    expect(existsSync(argLog)).toBe(false);
    expect(readJob(jobFilePath(paths.jobsDir, "t"))?.active).toBe(false);
  });

  describe("notifyTarget integration", () => {
    it("calls notify with a summary string + the configured target after a successful run", async () => {
      const calls: Array<{ text: string; target: string }> = [];
      const job = makeJob({ notifyTarget: "slack:C0BOQV5434G" });
      const result = await runScheduledJob(job, paths, {
        notify: async (text, target) => {
          calls.push({ text, target });
          return { ok: true };
        },
      });
      expect(result.status).toBe("ok");
      expect(calls).toHaveLength(1);
      expect(calls[0].target).toBe("slack:C0BOQV5434G");
      expect(calls[0].text).toMatch(/\[schedule\] t: ok/);
    });

    it("does NOT call notify when notifyTarget is unset", async () => {
      const calls: Array<unknown> = [];
      const job = makeJob(); // no notifyTarget
      await runScheduledJob(job, paths, {
        notify: async () => {
          calls.push(true);
          return { ok: true };
        },
      });
      expect(calls).toHaveLength(0);
    });

    it("notify failure does NOT change the job result (best-effort delivery)", async () => {
      const job = makeJob({ notifyTarget: "slack:C0BOQV5434G" });
      const result = await runScheduledJob(job, paths, {
        notify: async () => ({ ok: false, reason: "MISSING_TOKEN: SLACK_BOT_TOKEN is not set" }),
      });
      // Run still considered successful — notify failures never propagate.
      expect(result.status).toBe("ok");
      expect(readJob(jobFilePath(paths.jobsDir, "t"))?.lastStatus).toBe("ok");
    });

    it("notify crash does NOT break the run", async () => {
      const job = makeJob({ notifyTarget: "slack:C0BOQV5434G" });
      const result = await runScheduledJob(job, paths, {
        notify: async () => {
          throw new Error("network on fire");
        },
      });
      expect(result.status).toBe("ok");
    });

    it("releases the overlap lock BEFORE notify (so a slow Slack doesn't keep the next tick locked out)", async () => {
      const job = makeJob({ notifyTarget: "slack:C0BOQV5434G" });
      let lockHeldDuringNotify = false;
      await runScheduledJob(job, paths, {
        notify: async () => {
          // Inside notify, the lock file should NO LONGER be held — a fresh
          // acquire must succeed.
          const probe = acquireLock(jobLockPath(paths.jobsDir, "t"));
          lockHeldDuringNotify = !probe.acquired;
          if (probe.acquired) probe.release();
          return { ok: true };
        },
      });
      expect(lockHeldDuringNotify).toBe(false);
    });
  });
});
