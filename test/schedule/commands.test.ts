import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OS installer so no real launchctl/crontab runs.
vi.mock("../../src/schedule/installer.js", () => ({
  installJob: vi.fn(() => ({ backend: "crontab", installed: true })),
  uninstallJob: vi.fn(),
  getInstalledStatus: vi.fn(() => false),
}));

import { installJob, uninstallJob } from "../../src/schedule/installer.js";
import { readJob } from "../../src/schedule/job-store.js";
import { jobFilePath, resolveSchedulePaths } from "../../src/schedule/paths.js";
import {
  addScheduleJob,
  listScheduleJobs,
  removeScheduleJob,
  resolveOmpBinPath,
} from "../../src/schedule/commands.js";

let root: string;
const savedBin = process.env.OMP_BIN;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omp-sched-cmd-"));
  vi.clearAllMocks();
});
afterEach(() => {
  if (savedBin === undefined) delete process.env.OMP_BIN;
  else process.env.OMP_BIN = savedBin;
});

describe("addScheduleJob", () => {
  it("rejects an invalid id", () => {
    const r = addScheduleJob(root, { id: "bad id!", cron: "*/5 * * * *", prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid --id/);
  });

  it("rejects a non-5-field cron", () => {
    const r = addScheduleJob(root, { id: "j", cron: "*/5 * *", prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid --cron/);
  });

  it("rejects a cwd that does not exist", () => {
    const r = addScheduleJob(root, { id: "j", cron: "*/5 * * * *", prompt: "x", cwd: "/no/such/dir/zzz" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/--cwd does not exist/);
  });

  it("applies defaults, installs, and persists the resolved backend", () => {
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "check PR" });
    expect(r.ok).toBe(true);
    expect(installJob).toHaveBeenCalledOnce();
    const paths = resolveSchedulePaths(root);
    const job = readJob(jobFilePath(paths.jobsDir, "pr"));
    expect(job?.timeoutMs).toBe(300_000);
    expect(job?.allowAllTools).toBe(false);
    expect(job?.expiresAt).toBeTruthy();
    expect(job?.backend).toBe("crontab");
    // default (no allow-all) prints the limited-capability INFO note
    expect(r.messages.join(" ")).toMatch(/without --allow-all-tools/);
  });

  it("prints a WARNING when --allow-all-tools is set", () => {
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x", allowAllTools: true });
    expect(r.messages.join(" ")).toMatch(/WARNING.*full tool access/);
  });

  it("dry-run does not write a job file", () => {
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x", dryRun: true });
    expect(r.ok).toBe(true);
    expect(installJob).not.toHaveBeenCalled();
    expect(existsSync(jobFilePath(resolveSchedulePaths(root).jobsDir, "pr"))).toBe(false);
  });

  it("re-adding the same id is idempotent (overwrites)", () => {
    addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "first" });
    addScheduleJob(root, { id: "pr", cron: "*/30 * * * *", prompt: "second" });
    expect(listScheduleJobs(root).filter((j) => j.id === "pr")).toHaveLength(1);
    expect(readJob(jobFilePath(resolveSchedulePaths(root).jobsDir, "pr"))?.prompt).toBe("second");
  });

  it("re-add uninstalls the PRIOR recorded backend (no orphan on backend change)", () => {
    vi.mocked(installJob).mockReturnValueOnce({ backend: "launchd", installed: true });
    addScheduleJob(root, { id: "pr", cron: "0 9 * * *", prompt: "first" }); // recorded backend: launchd
    vi.mocked(uninstallJob).mockClear();
    addScheduleJob(root, { id: "pr", cron: "0 9,12 * * 1-5", prompt: "second" }); // would detect crontab
    // the re-add must uninstall the OLD entry by its recorded backend (launchd), not just crontab
    expect(uninstallJob).toHaveBeenCalledWith("pr", "launchd");
  });
});

describe("resolveOmpBinPath", () => {
  it("uses OMP_BIN and the basename is omp, not cli.js", () => {
    process.env.OMP_BIN = "/usr/local/bin/omp";
    expect(path.basename(resolveOmpBinPath())).toBe("omp");
  });
});

describe("removeScheduleJob", () => {
  it("uninstalls by backend and deletes the job", () => {
    addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x" });
    const r = removeScheduleJob(root, "pr");
    expect(r.removed).toBe(true);
    expect(uninstallJob).toHaveBeenCalledWith("pr", "crontab");
    expect(listScheduleJobs(root)).toHaveLength(0);
  });

  it("returns removed=false for a missing id", () => {
    expect(removeScheduleJob(root, "nope")).toEqual({ removed: false, uninstalled: false });
  });
});
