import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isHeartbeatStale, readHeartbeat, writeHeartbeat } from "../../src/team/heartbeat.js";

describe("heartbeat", () => {
  it("round-trips through disk", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "omp-hb-")), "heartbeat.json");
    const hb = {
      pid: 123,
      workerName: "worker-1",
      teamName: "t",
      lastPollAt: new Date().toISOString(),
      turnCount: 5,
      alive: true,
    };
    writeHeartbeat(file, hb);
    const out = readHeartbeat(file);
    expect(out).toEqual(hb);
  });

  it("returns undefined when the heartbeat file is missing", () => {
    expect(readHeartbeat("/tmp/definitely-missing-heartbeat-xyz")).toBeUndefined();
  });

  it("marks missing or stale heartbeats", () => {
    expect(isHeartbeatStale(undefined)).toBe(true);
    expect(
      isHeartbeatStale(
        {
          pid: 1,
          workerName: "w",
          teamName: "t",
          lastPollAt: new Date(Date.now() - 60_000).toISOString(),
          turnCount: 0,
          alive: true,
        },
        Date.now(),
        30_000,
      ),
    ).toBe(true);
    expect(
      isHeartbeatStale(
        {
          pid: 1,
          workerName: "w",
          teamName: "t",
          lastPollAt: new Date().toISOString(),
          turnCount: 0,
          alive: true,
        },
        Date.now(),
        30_000,
      ),
    ).toBe(false);
  });
});
