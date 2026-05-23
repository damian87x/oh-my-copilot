import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureTeamDirs, ensureWorkerDirs, resolveTeamPaths, resolveWorkerPaths } from "../../src/team/state-paths.js";

describe("resolveTeamPaths", () => {
  it("places team state under cwd/.omc/state/team/<name>", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-team-paths-"));
    const t = resolveTeamPaths(cwd, "demo");
    expect(t.teamRoot).toBe(path.join(cwd, ".omc", "state", "team", "demo"));
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
