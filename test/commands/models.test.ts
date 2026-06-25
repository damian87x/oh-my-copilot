import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  collectModelReport,
  formatModelReport,
} from "../../src/commands/models.js";
import { KNOWN_MODEL_SLUGS } from "../../src/copilot/models.js";
import type { CouncilSpawn, SpawnResponse } from "../../src/council/types.js";

function resp(p: Partial<SpawnResponse>): SpawnResponse {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...p };
}
function spawnFromMap(map: Record<string, Partial<SpawnResponse>>): CouncilSpawn {
  return async (req) => resp(map[req.model] ?? {});
}

describe("buildCandidates", () => {
  it("includes the curated list as built-in", () => {
    const map = buildCandidates({});
    for (const slug of KNOWN_MODEL_SLUGS) expect(map.get(slug)).toBe("built-in");
  });

  it("tags the configured model as config (overriding built-in)", () => {
    const map = buildCandidates({ configured: "gpt-5-mini" });
    expect(map.get("gpt-5-mini")).toBe("config");
  });

  it("adds --candidates tagged candidate, deduped", () => {
    const map = buildCandidates({ candidates: ["foo", "foo", "bar"] });
    expect(map.get("foo")).toBe("candidate");
    expect(map.get("bar")).toBe("candidate");
    // a single entry per slug
    expect([...map.keys()].filter((k) => k === "foo")).toHaveLength(1);
  });
});

describe("collectModelReport", () => {
  it("reports per-model status with source and sorts available first", async () => {
    const sources = buildCandidates({ configured: "gpt-5-mini", candidates: ["bad", "mystery"] });
    const spawn = spawnFromMap({
      "gpt-5-mini": { exitCode: 0 },
      "bad": { exitCode: 1, stderr: 'Model "bad" is not available.' },
      "mystery": { exitCode: 1, stderr: "weird network thing" },
    });
    const rows = await collectModelReport(spawn, sources, { timeoutMs: 10 });

    const mini = rows.find((r) => r.slug === "gpt-5-mini");
    expect(mini).toMatchObject({ status: "available", source: "config" });
    expect(rows.find((r) => r.slug === "bad")).toMatchObject({ status: "unavailable", source: "candidate" });
    expect(rows.find((r) => r.slug === "mystery")).toMatchObject({ status: "unknown", source: "candidate" });
    // available sorts before unavailable/unknown
    expect(rows[0].status).toBe("available");
  });
});

describe("formatModelReport", () => {
  it("renders markers and source tags", () => {
    const text = formatModelReport([
      { slug: "gpt-5-mini", status: "available", source: "config" },
      { slug: "bad", status: "unavailable", source: "candidate" },
    ]);
    expect(text).toContain("✓ gpt-5-mini (config)");
    expect(text).toContain("✗ bad (candidate)");
  });
});
