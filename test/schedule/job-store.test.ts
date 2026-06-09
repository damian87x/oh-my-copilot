import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  appendRunResult,
  deleteJob,
  listJobs,
  readJob,
  readResultsFrom,
  writeJob,
} from "../../src/schedule/job-store.js";
import {
  ensureScheduleDirs,
  jobFilePath,
  resolveSchedulePaths,
  resultsCursorPath,
  resultsFilePath,
} from "../../src/schedule/paths.js";
import type { ScheduleJob, ScheduleRunResult } from "../../src/schedule/types.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "omp-sched-store-"));

function sampleJob(id: string): ScheduleJob {
  return {
    id,
    cron: "*/15 * * * *",
    prompt: "check the PR",
    bin: "copilot",
    cwd: "/tmp/x",
    timeoutMs: 300_000,
    allowAllTools: false,
    createdAt: new Date().toISOString(),
    runCount: 0,
    backend: "crontab",
    ompBinPath: "/usr/local/bin/omp",
    active: true,
  };
}

function sampleResult(i: number): ScheduleRunResult {
  return {
    ts: new Date().toISOString(),
    exitCode: 0,
    status: "ok",
    summary: `run ${i}`,
    logPath: `/tmp/log-${i}.log`,
    durationMs: 10,
  };
}

describe("schedule job-store", () => {
  it("writeJob/readJob round-trips and listJobs is sorted", () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    ensureScheduleDirs(paths);
    writeJob(jobFilePath(paths.jobsDir, "b-job"), sampleJob("b-job"));
    writeJob(jobFilePath(paths.jobsDir, "a-job"), sampleJob("a-job"));
    expect(readJob(jobFilePath(paths.jobsDir, "a-job"))?.prompt).toBe("check the PR");
    expect(listJobs(paths.jobsDir).map((j) => j.id)).toEqual(["a-job", "b-job"]);
  });

  it("deleteJob removes the file; readJob of missing returns undefined", () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    const p = jobFilePath(paths.jobsDir, "x");
    writeJob(p, sampleJob("x"));
    expect(existsSync(p)).toBe(true);
    deleteJob(p);
    expect(existsSync(p)).toBe(false);
    expect(readJob(p)).toBeUndefined();
  });

  it("appendRunResult is append-only (prior bytes never rewritten)", () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    const rp = resultsFilePath(paths.resultsDir, "x");
    appendRunResult(rp, sampleResult(1));
    const afterFirst = statSync(rp).size;
    const firstBytes = readFileSync(rp);
    appendRunResult(rp, sampleResult(2));
    const afterSecond = statSync(rp).size;
    expect(afterSecond).toBeGreaterThan(afterFirst);
    // first line's bytes are unchanged (pure append)
    expect(readFileSync(rp).subarray(0, firstBytes.length).equals(firstBytes)).toBe(true);
  });

  it("readResultsFrom reads only entries past the cursor and advances monotonically", () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    const rp = resultsFilePath(paths.resultsDir, "x");
    const cp = resultsCursorPath(paths.resultsDir, "x");
    appendRunResult(rp, sampleResult(1));
    appendRunResult(rp, sampleResult(2));
    const scan1 = readResultsFrom(rp, cp);
    expect(scan1.results.map((r) => r.summary)).toEqual(["run 1", "run 2"]);
    advanceCursor(cp, scan1.newCursor);
    // nothing new
    expect(readResultsFrom(rp, cp).results).toEqual([]);
    // append a third, only that one is unseen
    appendRunResult(rp, sampleResult(3));
    const scan2 = readResultsFrom(rp, cp);
    expect(scan2.results.map((r) => r.summary)).toEqual(["run 3"]);
    expect(scan2.newCursor).toBeGreaterThanOrEqual(scan1.newCursor);
  });

  it("resets the cursor when the results file is truncated/rotated", () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    const rp = resultsFilePath(paths.resultsDir, "x");
    const cp = resultsCursorPath(paths.resultsDir, "x");
    appendRunResult(rp, sampleResult(1));
    appendRunResult(rp, sampleResult(2));
    appendRunResult(rp, sampleResult(3));
    advanceCursor(cp, readResultsFrom(rp, cp).newCursor); // cursor at EOF
    // rotate: replace with a smaller file (offset now > size)
    writeFileSync(rp, `${JSON.stringify(sampleResult(99))}\n`);
    const scan = readResultsFrom(rp, cp);
    expect(scan.results.map((r) => r.summary)).toEqual(["run 99"]);
  });

  it("C1: concurrent appends lose no lines, never tear JSON, cursor <= filesize", async () => {
    const root = tmp();
    const paths = resolveSchedulePaths(root);
    const rp = resultsFilePath(paths.resultsDir, "x");
    const cp = resultsCursorPath(paths.resultsDir, "x");
    const N = 24;
    // fire concurrent appends interleaved with a cursor read/advance
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() => {
          appendRunResult(rp, sampleResult(i));
          if (i % 5 === 0) {
            const scan = readResultsFrom(rp, cp);
            advanceCursor(cp, scan.newCursor);
          }
        }),
      ),
    );
    const lines = readFileSync(rp, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(N); // no lost lines
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow(); // no torn writes
    }
    const finalCursor = readResultsFrom(rp, cp).newCursor;
    expect(finalCursor).toBeLessThanOrEqual(statSync(rp).size);
  });
});
