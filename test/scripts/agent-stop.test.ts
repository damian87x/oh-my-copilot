import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentStopLocksPath } from "../../src/mode-state/paths.js";
import { cancelRalph, readRalph, startRalph } from "../../src/mode-state/ralph.js";
// @ts-expect-error - plain .mjs hook script exports are exercised as public hook handlers.
import { agentStopLocksDir, claimAgentStopCounter, handleAgentStop } from "../../scripts/agent-stop.mjs";

const fixtures: string[] = [];

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-agent-stop-"));
  fixtures.push(root);
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  const subdir = path.join(root, "packages", "service");
  mkdirSync(subdir, { recursive: true });
  return { root, subdir };
}

function runAgentStop(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  return handleAgentStop(JSON.stringify(payload), env) as { decision: "allow" | "block"; reason?: string };
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function ralphFile(root: string) {
  return path.join(root, ".omp", "state", "ralph.json");
}

function markerNames(root: string) {
  try {
    return readdirSync(agentStopLocksDir(root));
  } catch {
    return [];
  }
}

function ralphMarkers(root: string) {
  return markerNames(root).filter((name) => name.startsWith("agentstop-ralph-"));
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-stop idempotency guard", () => {
  it("claims a same-run counter value once and allows different counter values", () => {
    const { root } = makeFixture();
    const startedAt = "2026-07-05T01:02:03.004Z";

    expect(
      claimAgentStopCounter({
        directory: root,
        mode: "ralph",
        sessionId: "sid:with/slash",
        startedAt,
        counterValue: 1,
      }),
    ).toBe(true);
    expect(
      claimAgentStopCounter({
        directory: root,
        mode: "ralph",
        sessionId: "sid:with/slash",
        startedAt,
        counterValue: 1,
      }),
    ).toBe(false);
    expect(
      claimAgentStopCounter({
        directory: root,
        mode: "ralph",
        sessionId: "sid:with/slash",
        startedAt,
        counterValue: 2,
      }),
    ).toBe(true);

    const markers = ralphMarkers(root);
    expect(markers).toHaveLength(2);
    expect(markers.join("\n")).toContain("sid_with_slash");
    expect(markers.join("\n")).not.toContain(":");
  });

  it("block->patch writes state and markers from repo root and subdirectory payloads", () => {
    for (const payloadKind of ["root", "subdir"] as const) {
      const { root, subdir } = makeFixture();
      const cwd = payloadKind === "root" ? root : subdir;
      startRalph({ cwd, prompt: "finish hardening", maxIterations: 4, sessionId: "state-session" });

      const out = runAgentStop({ cwd, session_id: "hook-session" });

      expect(out.decision).toBe("block");
      expect(readJson(ralphFile(root)).iteration).toBe(1);
      expect(existsSync(path.join(subdir, ".omp", "state", "ralph.json"))).toBe(false);
      expect(ralphMarkers(root)).toHaveLength(1);
    }
  });

  it("guard errors fail open toward counting without changing the block decision", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4 });
    writeFileSync(agentStopLocksPath(root), "not a directory", "utf8");

    const out = runAgentStop({ cwd: root, sessionId: "s1" });

    expect(out.decision).toBe("block");
    expect(readJson(ralphFile(root)).iteration).toBe(1);
  });

  it("sentinel->clear and cap->clear leave the decision allow and purge mode markers", () => {
    const sentinel = makeFixture();
    startRalph({ cwd: sentinel.root, prompt: "finish hardening", maxIterations: 4 });
    mkdirSync(agentStopLocksDir(sentinel.root), { recursive: true });
    writeFileSync(path.join(agentStopLocksDir(sentinel.root), "agentstop-ralph-old-1-1"), "", "utf8");
    const transcript = path.join(sentinel.root, "transcript.txt");
    writeFileSync(transcript, "done\nRALPH_COMPLETE\n", "utf8");

    const sentinelOut = runAgentStop({ cwd: sentinel.root, transcriptPath: transcript });

    expect(sentinelOut.decision).toBe("allow");
    expect(readJson(ralphFile(sentinel.root)).active).toBe(false);
    expect(ralphMarkers(sentinel.root)).toHaveLength(0);

    const capped = makeFixture();
    startRalph({ cwd: capped.root, prompt: "finish hardening", maxIterations: 2 });
    expect(runAgentStop({ cwd: capped.root, sessionId: "s1" }).decision).toBe("block");
    expect(ralphMarkers(capped.root)).toHaveLength(1);

    const capOut = runAgentStop({ cwd: capped.root, sessionId: "s1" });

    expect(capOut.decision).toBe("allow");
    expect(readJson(ralphFile(capped.root)).active).toBe(false);
    expect(ralphMarkers(capped.root)).toHaveLength(0);
  });

  it("OMP_TEAM_WORKER skips loop injection and does not advance counters", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4 });

    const out = runAgentStop({ cwd: root, sessionId: "s1" }, { OMP_TEAM_WORKER: "1" });

    expect(out.decision).toBe("allow");
    expect(readJson(ralphFile(root)).iteration).toBe(0);
    expect(ralphMarkers(root)).toHaveLength(0);
  });

  it("fresh starts do not freeze on previous-run markers and eventually hit the configured cap", () => {
    vi.useFakeTimers();
    const { root } = makeFixture();

    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
    const first = startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "same" });
    expect(runAgentStop({ cwd: root, sessionId: "same" }).decision).toBe("block");
    expect(readJson(ralphFile(root)).iteration).toBe(1);
    expect(ralphMarkers(root)).toHaveLength(1);

    cancelRalph(root);
    expect(ralphMarkers(root)).toHaveLength(0);

    vi.setSystemTime(new Date("2026-07-05T00:01:00.000Z"));
    startRalph({ cwd: root, prompt: "finish hardening again", maxIterations: 4, sessionId: "same" });
    expect(
      claimAgentStopCounter({
        directory: root,
        mode: "ralph",
        sessionId: "same",
        startedAt: first.startedAt,
        counterValue: 1,
      }),
    ).toBe(true);

    const observedIterations: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const out = runAgentStop({ cwd: root, sessionId: "same" });
      const state = readRalph(root);
      if (typeof state?.iteration === "number") observedIterations.push(state.iteration);
      if (out.decision === "allow") break;
    }

    expect(Math.max(...observedIterations)).toBeGreaterThan(1);
    expect(readRalph(root)?.active).toBe(false);
    expect(readFileSync(path.join(root, ".omp", "state", "hooks.log"), "utf8")).toContain("reached max (4)");
  });

  it("omp ralph start deletes pre-existing ralph agent-stop markers only", () => {
    const { root } = makeFixture();
    const locks = agentStopLocksDir(root);
    mkdirSync(locks, { recursive: true });
    writeFileSync(path.join(locks, "agentstop-ralph-stale-1-1"), "", "utf8");
    writeFileSync(path.join(locks, "agentstop-ultraqa-stale-1-1"), "", "utf8");

    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4 });

    expect(markerNames(root)).not.toContain("agentstop-ralph-stale-1-1");
    expect(markerNames(root)).toContain("agentstop-ultraqa-stale-1-1");
  });
});
