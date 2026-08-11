import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureTeamDirs,
  ensureTeamMonitorDirs,
  ensureWorkerDirs,
  resolveTeamMonitorPaths,
  resolveTeamPaths,
  resolveWorkerPaths,
} from "../../src/team/state-paths.js";

describe("resolveTeamPaths", () => {
  it("places team state under cwd/.omp/state/team/<name>", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-paths-"));
    const t = resolveTeamPaths(cwd, "demo");
    expect(t.teamRoot).toBe(path.join(cwd, ".omp", "state", "team", "demo"));
    expect(t.configFile).toBe(path.join(t.teamRoot, "config.json"));
    expect(t.tasksDir).toBe(path.join(t.teamRoot, "tasks"));
    expect(t.workersDir).toBe(path.join(t.teamRoot, "workers"));
  });

  it("derives worker paths under workers/<name>", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-paths-"));
    const t = resolveTeamPaths(cwd, "demo");
    const w = resolveWorkerPaths(t, "worker-1");
    expect(w.workerRoot).toBe(path.join(t.workersDir, "worker-1"));
    expect(w.inboxFile).toBe(path.join(w.workerRoot, "inbox.md"));
    expect(w.outboxFile).toBe(path.join(w.workerRoot, "outbox.jsonl"));
    expect(w.outboxOffsetFile).toBe(path.join(w.workerRoot, ".outbox-offset"));
    expect(w.heartbeatFile).toBe(path.join(w.workerRoot, "heartbeat.json"));
  });

  it("rejects path-like team and worker names", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-paths-"));
    expect(() => resolveTeamPaths(cwd, "../../../escape")).toThrow(
      /invalid team name/i,
    );
    const team = resolveTeamPaths(cwd, "demo");
    expect(() => resolveWorkerPaths(team, "../escape")).toThrow(
      /invalid worker name/i,
    );
  });
});

describe("ensure*Dirs", () => {
  it("creates the team + worker directories idempotently", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-mkdirs-"));
    const t = resolveTeamPaths(cwd, "demo");
    ensureTeamDirs(t);
    ensureTeamDirs(t);
    expect(existsSync(t.tasksDir)).toBe(true);
    expect(existsSync(t.workersDir)).toBe(true);
    const w = resolveWorkerPaths(t, "worker-1");
    ensureWorkerDirs(w);
    expect(existsSync(w.workerRoot)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("trusted team state roots", () => {
  it("rejects a symlinked team root without creating state outside the project", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "omc-team-outside-"));
    mkdirSync(path.join(cwd, ".omp", "state"), { recursive: true });
    symlinkSync(outside, path.join(cwd, ".omp", "state", "team"), "dir");

    expect(() => ensureTeamDirs(resolveTeamPaths(cwd, "demo"))).toThrow(
      /symlink-ancestor/i,
    );
    expect(existsSync(path.join(outside, "demo"))).toBe(false);
  });

  it("rejects a symlinked monitor root without creating state outside the project", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-monitor-root-"));
    const outside = mkdtempSync(path.join(tmpdir(), "omc-monitor-outside-"));
    mkdirSync(path.join(cwd, ".omp", "state"), { recursive: true });
    symlinkSync(
      outside,
      path.join(cwd, ".omp", "state", "team-monitor"),
      "dir",
    );

    expect(() =>
      ensureTeamMonitorDirs(resolveTeamMonitorPaths(cwd)),
    ).toThrow(/symlink-ancestor/i);
    expect(existsSync(path.join(outside, "visual"))).toBe(false);
    expect(existsSync(path.join(outside, "targets"))).toBe(false);
  });
});
