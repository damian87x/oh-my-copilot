import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentStopLocksPath } from "../../src/mode-state/paths.js";
import { cancelRalph, readRalph, startRalph } from "../../src/mode-state/ralph.js";
import { readUltraqa, recordUltraqaCycle, startUltraqa } from "../../src/mode-state/ultraqa.js";
// @ts-expect-error - plain .mjs hook script exports are exercised as public hook handlers.
import { agentStopLocksDir, claimAgentStopCounter, handleAgentStop, releaseAgentStopMarker } from "../../scripts/agent-stop.mjs";

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
  // Tests fire stops back-to-back to simulate whole turns, so the duplicate-fire
  // dedupe window is disabled by default; dedupe tests opt back in explicitly.
  return handleAgentStop(JSON.stringify(payload), { OMP_AGENTSTOP_DEDUPE_MS: "0", ...env }) as {
    decision: "allow" | "block";
    reason?: string;
  };
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function ralphFile(root: string) {
  return path.join(root, ".omp", "state", "ralph.json");
}

function ultraqaFile(root: string) {
  return path.join(root, ".omp", "state", "ultraqa.json");
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

  it("releasing a claimed marker lets the same counter value be re-counted (no freeze on write failure)", () => {
    const { root } = makeFixture();
    const startedAt = "2026-07-05T01:02:03.004Z";
    const key = { directory: root, mode: "ralph", sessionId: "sid", startedAt, counterValue: 4 };

    // First fire claims counter value 4.
    expect(claimAgentStopCounter({ ...key })).toBe(true);
    // A second fire for the same value is deduped while the marker stands.
    expect(claimAgentStopCounter({ ...key })).toBe(false);
    // Simulate the state write failing: the marker is rolled back.
    releaseAgentStopMarker({ ...key });
    // The next fire can now re-count value 4 instead of freezing on EEXIST.
    expect(claimAgentStopCounter({ ...key })).toBe(true);
  });

  it("handleAgentStop rolls back the marker when the counter write fails, so the retry recovers (no freeze)", () => {
    // root bypasses chmod permission bits, so this cannot exercise a write failure there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "s1" });
    // Pre-create the locks dir so the marker claim still succeeds while only the
    // counter write is blocked — this reproduces the exact write-failure window.
    mkdirSync(agentStopLocksDir(root), { recursive: true });
    const stateDir = path.join(root, ".omp", "state");
    chmodSync(stateDir, 0o500); // read-only: writeState's tmp write throws EACCES

    try {
      const out = runAgentStop({ cwd: root, sessionId: "s1" });
      expect(out.decision).toBe("block"); // still injects the next-turn prompt
      expect(readJson(ralphFile(root)).iteration).toBe(0); // write failed → not advanced
      expect(ralphMarkers(root)).toHaveLength(0); // marker rolled back — no stale EEXIST
    } finally {
      chmodSync(stateDir, 0o700); // restore so the retry + cleanup can write
    }

    // With the marker rolled back, the retry re-counts instead of freezing at 0.
    const recovered = runAgentStop({ cwd: root, sessionId: "s1" });
    expect(recovered.decision).toBe("block");
    expect(readJson(ralphFile(root)).iteration).toBe(1);
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
    startRalph({ cwd: capped.root, prompt: "finish hardening", maxIterations: 4 });
    const decisions: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      decisions.push(runAgentStop({ cwd: capped.root, sessionId: "s1" }).decision);
      expect(readJson(ralphFile(capped.root)).iteration).toBe(i + 1);
    }
    expect(decisions).toEqual(["block", "block", "block", "block"]);
    expect(ralphMarkers(capped.root)).toHaveLength(4);

    const capOut = runAgentStop({ cwd: capped.root, sessionId: "s1" });

    expect(capOut.decision).toBe("allow");
    expect(readJson(ralphFile(capped.root)).active).toBe(false);
    expect(ralphMarkers(capped.root)).toHaveLength(0);
  });

  it("ultraqa maxCycles=4 grants four hook-driven cycles despite interleaved fail records", () => {
    const { root } = makeFixture();
    startUltraqa({ cwd: root, goal: "finish hardening QA", maxCycles: 4 });

    const decisions: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const out = runAgentStop({ cwd: root, sessionId: "s1" });
      decisions.push(out.decision);
      expect(readJson(ultraqaFile(root)).cycleCount).toBe(i + 1);

      const cycle = recordUltraqaCycle(root, "fail");
      expect(cycle.ok).toBe(true);
      expect(cycle.state).toMatchObject({ cycleCount: i + 1, lastVerdict: "fail" });
      expect(readJson(ultraqaFile(root))).toMatchObject({ active: true, cycleCount: i + 1, lastVerdict: "fail" });
    }

    expect(decisions).toEqual(["block", "block", "block", "block"]);
    const capOut = runAgentStop({ cwd: root, sessionId: "s1" });

    expect(capOut.decision).toBe("allow");
    expect(readUltraqa(root)?.active).toBe(false);
    expect(readJson(ultraqaFile(root))).toMatchObject({ active: false, cycleCount: 4, lastVerdict: "fail" });
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

// Issue #75: the transcript is Copilot's events.jsonl; the injected continuation
// prompt flows back inside user.message events and must not read as completion.
describe("agent-stop transcript sentinel scanning", () => {
  function writeEvents(root: string, events: Array<Record<string, unknown>>) {
    const transcript = path.join(root, "events.jsonl");
    writeFileSync(transcript, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return transcript;
  }

  it("ignores the injected instruction inside user.message events and keeps looping", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 3, sessionId: "s1" });
    const transcript = writeEvents(root, [
      {
        type: "user.message",
        data: {
          content: "go",
          transformedContent:
            "[RALPH ITERATION 1/3] Not finished. Continue the task. " +
            "When ALL acceptance criteria pass, output the exact token RALPH_COMPLETE on its own line.",
        },
      },
      { type: "assistant.message", data: { content: "still working on step 2" } },
    ]);

    const out = runAgentStop({ cwd: root, sessionId: "s1", transcriptPath: transcript });

    expect(out.decision).toBe("block");
    expect(readJson(ralphFile(root))).toMatchObject({ active: true, iteration: 1 });
  });

  it("clears the loop when the assistant outputs the sentinel on its own line", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 3, sessionId: "s1" });
    const transcript = writeEvents(root, [
      { type: "assistant.message", data: { content: "all criteria pass\nRALPH_COMPLETE" } },
    ]);

    const out = runAgentStop({ cwd: root, sessionId: "s1", transcriptPath: transcript });

    expect(out.decision).toBe("allow");
    expect(readJson(ralphFile(root)).active).toBe(false);
  });

  it("does not clear when the assistant only mentions the sentinel mid-sentence", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 3, sessionId: "s1" });
    const transcript = writeEvents(root, [
      { type: "assistant.message", data: { content: "I will output RALPH_COMPLETE when done" } },
    ]);

    const out = runAgentStop({ cwd: root, sessionId: "s1", transcriptPath: transcript });

    expect(out.decision).toBe("block");
    expect(readJson(ralphFile(root))).toMatchObject({ active: true, iteration: 1 });
  });
});

// Issue #76: Copilot 1.0.68 fires every hook twice (~50ms apart, same session).
// A duplicate fire inside the dedupe window must replay the first decision
// verbatim instead of recomputing against already-advanced state.
describe("agent-stop duplicate-fire dedupe", () => {
  const DEDUPE_ENV = { OMP_AGENTSTOP_DEDUPE_MS: "3000" };

  it("replays the first decision for a duplicate fire within the window", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "s1" });

    const first = runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV);
    const second = runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV);

    expect(first.decision).toBe("block");
    expect(second).toEqual(first); // identical decision AND injected reason
    expect(readJson(ralphFile(root)).iteration).toBe(1); // counted once, not twice
    const log = readFileSync(path.join(root, ".omp", "state", "hooks.log"), "utf8");
    expect(log).toContain('"deduped":true');
  });

  it("replays an allow decision too, so a duplicate cannot resurrect or re-drive the loop", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 3, sessionId: "s1" });
    const transcript = path.join(root, "events.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "assistant.message", data: { content: "RALPH_COMPLETE" } }) + "\n",
      "utf8",
    );

    const first = runAgentStop({ cwd: root, sessionId: "s1", transcriptPath: transcript }, DEDUPE_ENV);
    const second = runAgentStop({ cwd: root, sessionId: "s1", transcriptPath: transcript }, DEDUPE_ENV);

    expect(first.decision).toBe("allow");
    expect(second.decision).toBe("allow");
    expect(readJson(ralphFile(root)).active).toBe(false);
  });

  it("does not dedupe distinct stops outside the window", () => {
    vi.useFakeTimers();
    const { root } = makeFixture();
    vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "s1" });

    expect(runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV).decision).toBe("block");
    vi.setSystemTime(new Date("2026-07-06T00:00:10.000Z"));
    expect(runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV).decision).toBe("block");

    expect(readJson(ralphFile(root)).iteration).toBe(2);
  });

  it("does not dedupe across different sessions", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "s1" });

    expect(runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV).decision).toBe("block");
    expect(runAgentStop({ cwd: root, sessionId: "s2" }, DEDUPE_ENV).decision).toBe("block");

    expect(readJson(ralphFile(root)).iteration).toBe(2);
  });

  it("a corrupt decision cache fails open to normal processing", () => {
    const { root } = makeFixture();
    startRalph({ cwd: root, prompt: "finish hardening", maxIterations: 4, sessionId: "s1" });
    mkdirSync(agentStopLocksDir(root), { recursive: true });
    writeFileSync(path.join(agentStopLocksDir(root), "agentstop-decision-s1.json"), "not json", "utf8");

    const out = runAgentStop({ cwd: root, sessionId: "s1" }, DEDUPE_ENV);

    expect(out.decision).toBe("block");
    expect(readJson(ralphFile(root)).iteration).toBe(1);
  });
});
