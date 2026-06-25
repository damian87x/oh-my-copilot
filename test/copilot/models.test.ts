import { describe, expect, it } from "vitest";
import {
  KNOWN_MODEL_SLUGS,
  probeModel,
  probeModels,
} from "../../src/copilot/models.js";
import { isModelUnavailable } from "../../src/council/types.js";
import type { CouncilSpawn, SpawnResponse } from "../../src/council/types.js";

function resp(partial: Partial<SpawnResponse>): SpawnResponse {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...partial };
}

/** Spawn stub that answers per-model from a map; default = clean exit. */
function spawnFromMap(map: Record<string, Partial<SpawnResponse>>): CouncilSpawn {
  return async (req) => resp(map[req.model] ?? {});
}

describe("isModelUnavailable", () => {
  it("is true only for the entitlement signature on a non-zero, non-timeout exit", () => {
    expect(
      isModelUnavailable(resp({ exitCode: 1, stderr: 'Model "x" is not available.' })),
    ).toBe(true);
  });
  it("is false for a non-signature error", () => {
    expect(isModelUnavailable(resp({ exitCode: 1, stderr: "boom" }))).toBe(false);
  });
  it("is false for a clean exit", () => {
    expect(isModelUnavailable(resp({ exitCode: 0 }))).toBe(false);
  });
  it("is false for a timeout even if stderr matches", () => {
    expect(
      isModelUnavailable(resp({ exitCode: 1, timedOut: true, stderr: "is not available" })),
    ).toBe(false);
  });
});

describe("probeModel", () => {
  it("returns available on clean exit", async () => {
    const spawn = spawnFromMap({ good: { exitCode: 0 } });
    expect(await probeModel(spawn, "good")).toEqual({ model: "good", status: "available" });
  });
  it("returns unavailable on the entitlement signature", async () => {
    const spawn = spawnFromMap({ bad: { exitCode: 1, stderr: 'Model "bad" is not available.' } });
    expect(await probeModel(spawn, "bad")).toEqual({ model: "bad", status: "unavailable" });
  });
  it("returns unknown on a non-signature failure", async () => {
    const spawn = spawnFromMap({ flaky: { exitCode: 1, stderr: "network error" } });
    expect(await probeModel(spawn, "flaky")).toEqual({ model: "flaky", status: "unknown" });
  });
  it("returns unknown on a timeout with no output", async () => {
    const spawn = spawnFromMap({ slow: { exitCode: 124, timedOut: true } });
    expect(await probeModel(spawn, "slow")).toEqual({ model: "slow", status: "unknown" });
  });
  it("returns available when the model answered, even if copilot timed out (no clean exit)", async () => {
    // copilot -p often prints the reply but never exits → timedOut with stdout.
    const spawn = spawnFromMap({ hangs: { exitCode: 124, timedOut: true, stdout: "ok\n" } });
    expect(await probeModel(spawn, "hangs")).toEqual({ model: "hangs", status: "available" });
  });
  it("returns unknown when spawn throws", async () => {
    const spawn: CouncilSpawn = async () => {
      throw new Error("spawn failed");
    };
    expect(await probeModel(spawn, "x")).toEqual({ model: "x", status: "unknown" });
  });
});

describe("probeModels", () => {
  it("probes each distinct slug and reports per-model status", async () => {
    const spawn = spawnFromMap({
      "gpt-5-mini": { exitCode: 0 },
      "nope": { exitCode: 1, stderr: 'Model "nope" is not available.' },
    });
    const results = await probeModels(spawn, ["gpt-5-mini", "nope", "gpt-5-mini"]);
    // de-duped to 2
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.model === "gpt-5-mini")?.status).toBe("available");
    expect(results.find((r) => r.model === "nope")?.status).toBe("unavailable");
  });

  it("fires onProbe once per distinct model with a rising done count", async () => {
    const spawn = spawnFromMap({ a: { exitCode: 0 }, b: { exitCode: 0 } });
    const calls: Array<{ model: string; done: number; total: number }> = [];
    await probeModels(spawn, ["a", "b", "a"], {
      onProbe: (r, done, total) => calls.push({ model: r.model, done, total }),
    });
    expect(calls).toHaveLength(2); // distinct
    expect(calls.map((c) => c.done).sort()).toEqual([1, 2]);
    expect(calls.every((c) => c.total === 2)).toBe(true);
  });
});

describe("KNOWN_MODEL_SLUGS", () => {
  it("includes the default review model", () => {
    expect(KNOWN_MODEL_SLUGS).toContain("gpt-5-mini");
  });
});
