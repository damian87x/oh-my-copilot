import { describe, expect, it } from "vitest";
import { runCouncil, runWithConcurrency } from "../../src/council/engine.js";
import type {
  CouncilDeps,
  CouncilSpawn,
  CouncilTaskSpec,
  SpawnRequest,
  SpawnResponse,
} from "../../src/council/types.js";

function memberJson(verdict: string, confidence = 0.8): string {
  return `<<<JSON>>>{"verdict":"${verdict}","confidence":${confidence},"rationale":"r"}<<<END>>>`;
}
function synthJson(verdict = "final"): string {
  return `<<<JSON>>>{"verdict":"${verdict}","confidence":0.9,"rationale":"merged","minority_report":""}<<<END>>>`;
}

const isSynth = (prompt: string): boolean => prompt.includes("You are the synthesizer");

/** Build deps from a per-model response map; synth detected by prompt. */
function makeDeps(
  memberResponses: Record<string, Partial<SpawnResponse>>,
  synthResponse: Partial<SpawnResponse> = { stdout: synthJson(), exitCode: 0 },
  spy?: { calls: SpawnRequest[] },
): CouncilDeps {
  const spawn: CouncilSpawn = async (req) => {
    spy?.calls.push(req);
    if (isSynth(req.prompt)) {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...synthResponse };
    }
    const r = memberResponses[req.model] ?? { stdout: memberJson("ok"), exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...r };
  };
  return { spawn, now: () => 0, writeArtifact: () => {} };
}

const baseSpec = (extra: Partial<CouncilTaskSpec> = {}): CouncilTaskSpec => ({
  question: "Ship it?",
  synthesizerModel: "synth",
  members: [
    { model: "m1", role: "critic", weight: 1 },
    { model: "m2", role: "architect", weight: 1 },
    { model: "m3", role: "pragmatist", weight: 1 },
  ],
  ...extra,
});

describe("runCouncil", () => {
  it("all members respond -> synth called once, ok true", async () => {
    const spy = { calls: [] as SpawnRequest[] };
    const deps = makeDeps(
      {
        m1: { stdout: memberJson("a"), exitCode: 0 },
        m2: { stdout: memberJson("b"), exitCode: 0 },
        m3: { stdout: memberJson("c"), exitCode: 0 },
      },
      { stdout: synthJson("ship"), exitCode: 0 },
      spy,
    );
    const res = await runCouncil(baseSpec(), deps);
    expect(res.ok).toBe(true);
    expect(res.survivors).toBe(3);
    expect(res.dropped).toBe(0);
    expect(res.synth?.verdict).toBe("ship");
    expect(res.synth?.per_member_summary).toHaveLength(3);
    expect(spy.calls.filter((c) => isSynth(c.prompt))).toHaveLength(1);
  });

  it("graceful degradation: 1 timeout, 2 survive (minSurvivors 2) -> ok, dropped 1", async () => {
    const deps = makeDeps({
      m1: { stdout: memberJson("a"), exitCode: 0 },
      m2: { stdout: "", exitCode: 124, timedOut: true },
      m3: { stdout: memberJson("c"), exitCode: 0 },
    });
    const res = await runCouncil(baseSpec({ minSurvivors: 2 }), deps);
    expect(res.ok).toBe(true);
    expect(res.survivors).toBe(2);
    expect(res.dropped).toBe(1);
    const dropped = res.members.find((m) => m.spec.model === "m2");
    expect(dropped?.status).toBe("timeout");
  });

  it("too few survivors -> ok false, synth NOT called", async () => {
    const spy = { calls: [] as SpawnRequest[] };
    const deps = makeDeps(
      {
        m1: { stdout: memberJson("a"), exitCode: 0 },
        m2: { stdout: "", exitCode: 1 },
        m3: { stdout: "garbage no json", exitCode: 0 },
      },
      { stdout: synthJson(), exitCode: 0 },
      spy,
    );
    const res = await runCouncil(baseSpec({ minSurvivors: 2 }), deps);
    expect(res.ok).toBe(false);
    expect(res.survivors).toBe(1);
    expect(res.error).toMatch(/too few/i);
    expect(spy.calls.filter((c) => isSynth(c.prompt))).toHaveLength(0);
  });

  it("inline unavailability detection: exit!=0 + 'is not available' -> status unavailable", async () => {
    const deps = makeDeps({
      m1: { stdout: memberJson("a"), exitCode: 0 },
      m2: { stdout: memberJson("b"), exitCode: 0 },
      m3: { stdout: "", stderr: 'Error: Model "m3" from --model flag is not available.', exitCode: 1 },
    });
    const res = await runCouncil(baseSpec({ minSurvivors: 2 }), deps);
    expect(res.ok).toBe(true);
    const m3 = res.members.find((m) => m.spec.model === "m3");
    expect(m3?.status).toBe("unavailable");
    expect(res.error).toBeUndefined();
  });

  it("too-few-survivors error names the unavailable models", async () => {
    const deps = makeDeps({
      m1: { stdout: memberJson("a"), exitCode: 0 },
      m2: { stdout: "", stderr: 'Model "m2" is not available.', exitCode: 1 },
      m3: { stdout: "", stderr: 'Model "m3" is not available.', exitCode: 1 },
    });
    const res = await runCouncil(baseSpec({ minSurvivors: 2 }), deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/m2/);
    expect(res.error).toMatch(/m3/);
  });

  it("opt-in probe prunes unavailable but keeps slow models", async () => {
    // m2 is unavailable (probe + real both signal); m3 is slow on probe (timeout) but ok on real call.
    let m3Calls = 0;
    const spawn: CouncilSpawn = async (req) => {
      if (req.prompt.includes("You are the synthesizer")) {
        return { stdout: synthJson(), stderr: "", exitCode: 0, timedOut: false };
      }
      // probe prompt is the short "Reply with: ok"
      const isProbe = req.prompt === "Reply with: ok";
      if (req.model === "m1") return { stdout: memberJson("a"), stderr: "", exitCode: 0, timedOut: false };
      if (req.model === "m2")
        return { stdout: "", stderr: 'Model "m2" is not available.', exitCode: 1, timedOut: false };
      if (req.model === "m3") {
        m3Calls++;
        if (isProbe) return { stdout: "", stderr: "", exitCode: 124, timedOut: true }; // slow probe
        return { stdout: memberJson("c"), stderr: "", exitCode: 0, timedOut: false };
      }
      return { stdout: memberJson("x"), stderr: "", exitCode: 0, timedOut: false };
    };
    const deps: CouncilDeps = { spawn, now: () => 0, writeArtifact: () => {} };
    const res = await runCouncil(baseSpec({ minSurvivors: 2, probe: true }), deps);
    expect(res.ok).toBe(true);
    const m2 = res.members.find((m) => m.spec.model === "m2");
    expect(m2?.status).toBe("unavailable");
    const m3 = res.members.find((m) => m.spec.model === "m3");
    expect(m3?.status).toBe("ok"); // slow on probe, but kept and succeeded on the real call
    expect(m3Calls).toBeGreaterThanOrEqual(2); // probed + real call
  });

  it("decoy JSON block does not poison a member (first schema-valid wins)", async () => {
    const deps = makeDeps({
      m1: { stdout: '{"unrelated":1} <<<JSON>>>{"verdict":"truth","confidence":0.7,"rationale":"r"}<<<END>>>', exitCode: 0 },
      m2: { stdout: memberJson("b"), exitCode: 0 },
      m3: { stdout: memberJson("c"), exitCode: 0 },
    });
    const res = await runCouncil(baseSpec(), deps);
    const m1 = res.members.find((m) => m.spec.model === "m1");
    expect(m1?.output?.verdict).toBe("truth");
  });
});

describe("runWithConcurrency", () => {
  it("never exceeds the limit and preserves order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = async (n: number): Promise<number> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    };
    const out = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, worker);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
  });

  it("a rejected worker frees its slot (no deadlock)", async () => {
    const worker = async (n: number): Promise<number> => {
      if (n === 2) throw new Error("boom");
      return n;
    };
    await expect(runWithConcurrency([1, 2, 3, 4], 2, worker)).rejects.toThrow("boom");
  });
});
