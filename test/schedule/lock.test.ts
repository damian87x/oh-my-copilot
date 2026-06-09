import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, forceReleaseStaleLock, isLockStale } from "../../src/schedule/lock.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "omp-sched-lock-"));

describe("schedule lock", () => {
  it("acquireLock is exclusive; release removes the file", () => {
    const lp = path.join(tmp(), "x.lock");
    const a = acquireLock(lp);
    expect(a.acquired).toBe(true);
    expect(existsSync(lp)).toBe(true);
    const b = acquireLock(lp);
    expect(b.acquired).toBe(false); // second acquire fails
    a.release();
    expect(existsSync(lp)).toBe(false);
    // now acquirable again
    const c = acquireLock(lp);
    expect(c.acquired).toBe(true);
    c.release();
  });

  it("isLockStale returns true for a dead PID", () => {
    const lp = path.join(tmp(), "x.lock");
    // PID 999999 is almost certainly not alive
    writeFileSync(lp, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));
    expect(isLockStale(lp, 1000)).toBe(true);
  });

  it("isLockStale returns false for a live PID within age window", () => {
    const lp = path.join(tmp(), "x.lock");
    writeFileSync(lp, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    expect(isLockStale(lp, 60_000)).toBe(false);
  });

  it("release does NOT delete a lock that was stolen/replaced by a newer holder", () => {
    const lp = path.join(tmp(), "x.lock");
    const a = acquireLock(lp);
    expect(a.acquired).toBe(true);
    // simulate a stale-steal: another holder replaced our lock with its own token
    writeFileSync(lp, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token: "someone-else" }));
    a.release();
    expect(existsSync(lp)).toBe(true); // the newer lock survives
  });

  it("forceReleaseStaleLock removes a stale lock but leaves a live one", () => {
    const dir = tmp();
    const stale = path.join(dir, "stale.lock");
    const live = path.join(dir, "live.lock");
    writeFileSync(stale, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));
    writeFileSync(live, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    forceReleaseStaleLock(stale, 1000);
    forceReleaseStaleLock(live, 60_000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
