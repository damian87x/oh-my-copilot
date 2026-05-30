import { describe, expect, it } from "vitest";
import { synthesize } from "../../src/council/synth.js";
import type {
  CouncilDeps,
  CouncilMemberResult,
  CouncilTaskSpec,
  ResolvedCouncilConfig,
} from "../../src/council/types.js";

const config: ResolvedCouncilConfig = {
  members: [],
  synthesizerModel: "synth",
  minSurvivors: 2,
  perMemberTimeoutMs: 1000,
  synthTimeoutMs: 2000,
  maxConcurrency: 4,
  probe: false,
};

const spec: CouncilTaskSpec = { question: "Ship it?" };

const members: CouncilMemberResult[] = [
  {
    spec: { model: "m1", role: "critic", weight: 1 },
    status: "ok",
    durationMs: 1,
    output: { verdict: "yes", confidence: 0.8, rationale: "ok" },
  },
  {
    spec: { model: "m2", role: "architect", weight: 1 },
    status: "timeout",
    durationMs: 1,
    dropReason: "member timed out",
  },
];

function depsReturning(stdout: string, exitCode = 0, timedOut = false): CouncilDeps {
  return {
    spawn: async () => ({ stdout, stderr: "", exitCode, timedOut }),
    now: () => 0,
  };
}

describe("synthesize", () => {
  it("parses valid synth JSON and rebuilds per_member_summary from ALL members", async () => {
    const out = '<<<JSON>>>{"verdict":"final","confidence":0.9,"rationale":"merged","minority_report":"none"}<<<END>>>';
    const res = await synthesize(config, spec, members, depsReturning(out));
    expect(res.ok).toBe(true);
    expect(res.synth?.verdict).toBe("final");
    // includes the dropped member, marked dropped
    expect(res.synth?.per_member_summary).toHaveLength(2);
    const m2 = res.synth?.per_member_summary.find((s) => s.model === "m2");
    expect(m2?.dropped).toBe(true);
  });

  it("returns ok:false on garbage, never fabricates a verdict", async () => {
    const res = await synthesize(config, spec, members, depsReturning("no json here"));
    expect(res.ok).toBe(false);
    expect(res.synth).toBeUndefined();
    expect(res.error).toMatch(/unparseable/i);
    expect(res.rawStdout).toBe("no json here");
  });

  it("returns ok:false when the synth call exits non-zero", async () => {
    const res = await synthesize(config, spec, members, depsReturning("", 1));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited 1/);
  });

  it("returns ok:false when the synth call times out", async () => {
    const res = await synthesize(config, spec, members, depsReturning("", 124, true));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  it("passes synthTimeoutMs to the spawn call, not perMemberTimeoutMs", async () => {
    let capturedTimeout = 0;
    const deps: CouncilDeps = {
      spawn: async (req) => {
        capturedTimeout = req.timeoutMs;
        return { stdout: '<<<JSON>>>{"verdict":"v","confidence":0.9,"rationale":"r","minority_report":""}<<<END>>>', stderr: "", exitCode: 0, timedOut: false };
      },
      now: () => 0,
    };
    await synthesize(config, spec, members, deps);
    expect(capturedTimeout).toBe(config.synthTimeoutMs);
    expect(capturedTimeout).not.toBe(config.perMemberTimeoutMs);
  });
});
