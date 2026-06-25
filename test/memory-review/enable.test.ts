import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableMemoryMode, type EnableIO } from "../../src/memory-review/enable.js";
import { readMemoryConfig, setMemoryConfigValue } from "../../src/memory-review/config.js";
import type { CouncilSpawn, SpawnResponse } from "../../src/council/types.js";

const root = () => mkdtempSync(join(tmpdir(), "omc-enable-"));

function resp(p: Partial<SpawnResponse>): SpawnResponse {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...p };
}
/** Spawn stub: per-model response, default clean exit (available). */
function spawnFromMap(map: Record<string, Partial<SpawnResponse>>): CouncilSpawn {
  return async (req) => resp(map[req.model] ?? {});
}
/** Collects printed lines; ask returns a queued answer (or undefined). */
function makeIO(answers: (string | undefined)[] = []): EnableIO & { lines: string[] } {
  const lines: string[] = [];
  let i = 0;
  return {
    lines,
    print: (l) => lines.push(l),
    ask: async () => answers[i++],
  };
}

/** Read the global ~/.omp config the flow writes (home = the cwd here in tests). */
function readGlobal(home: string): Record<string, unknown> {
  const p = join(home, ".omp", "config.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

describe("enableMemoryMode", () => {
  it("non-interactive: validates the default and persists mode+model GLOBAL", async () => {
    const home = root();
    const io = makeIO();
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: false,
      validate: true,
      spawn: spawnFromMap({ "gpt-5-mini": { exitCode: 0 } }),
      io,
    });
    expect(res.ok).toBe(true);
    expect(res.model).toBe("gpt-5-mini");
    expect(readGlobal(home)).toMatchObject({ memoryMode: "on", memoryReviewModel: "gpt-5-mini" });
  });

  it("rejects an unavailable model and persists NOTHING", async () => {
    const home = root();
    const io = makeIO();
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: false,
      validate: true,
      explicitModel: "bad-model",
      spawn: spawnFromMap({ "bad-model": { exitCode: 1, stderr: 'Model "bad-model" is not available.' } }),
      io,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("bad-model");
    expect(res.message).toContain("omp models");
    expect(readGlobal(home)).toEqual({}); // nothing written
  });

  it("--no-validate skips probing and writes immediately", async () => {
    const home = root();
    let spawned = false;
    const spawn: CouncilSpawn = async () => {
      spawned = true;
      return resp({});
    };
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: false,
      validate: false,
      spawn,
      io: makeIO(),
    });
    expect(res.ok).toBe(true);
    expect(spawned).toBe(false);
    expect(readGlobal(home)).toMatchObject({ memoryMode: "on" });
  });

  it("interactive: empty answer selects the default", async () => {
    const home = root();
    const io = makeIO([""]); // press enter
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: true,
      validate: true,
      spawn: spawnFromMap({ "gpt-5-mini": { exitCode: 0 }, "gpt-4.1": { exitCode: 0 } }),
      io,
    });
    expect(res.ok).toBe(true);
    expect(res.model).toBe("gpt-5-mini");
    expect(io.lines.some((l) => l.includes("Available models"))).toBe(true);
  });

  it("interactive: a numeric answer picks from the available list", async () => {
    const home = root();
    const io = makeIO(["1"]);
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: true,
      validate: true,
      // only gpt-4.1 is available → it is item 1
      spawn: spawnFromMap({
        "gpt-5-mini": { exitCode: 1, stderr: 'Model "gpt-5-mini" is not available.' },
        "gpt-4.1": { exitCode: 0 },
      }),
      io,
    });
    expect(res.ok).toBe(true);
    expect(res.model).toBe("gpt-4.1");
  });

  it("clears a stale project memoryMode so the global enable is authoritative", async () => {
    const home = root();
    const cwd = root();
    // A leftover project memoryMode=off would otherwise shadow the global on
    // (readMemoryConfig merges project OVER global).
    setMemoryConfigValue(cwd, "memoryMode", "off", { scope: "project" });
    const res = await enableMemoryMode({
      cwd,
      homeDir: home,
      interactive: false,
      validate: false,
      spawn: spawnFromMap({}),
      io: makeIO(),
    });
    expect(res.ok).toBe(true);
    expect(readMemoryConfig(cwd, { homeDir: home }).memoryMode).toBe("on");
  });

  it("does not save a model on an out-of-range numeric pick", async () => {
    const home = root();
    const io = makeIO(["9"]); // only a couple available → 9 is invalid
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: true,
      validate: true,
      spawn: spawnFromMap({ "gpt-5-mini": { exitCode: 0 } }),
      io,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("invalid selection");
    expect(readGlobal(home)).toEqual({});
  });

  it("offline (unknown probe) warns but still saves", async () => {
    const home = root();
    const io = makeIO();
    const res = await enableMemoryMode({
      cwd: root(),
      homeDir: home,
      interactive: false,
      validate: true,
      // non-signature failure → unknown
      spawn: spawnFromMap({ "gpt-5-mini": { exitCode: 1, stderr: "network down" } }),
      io,
    });
    expect(res.ok).toBe(true);
    expect(io.lines.some((l) => l.toLowerCase().includes("could not verify"))).toBe(true);
    expect(readGlobal(home)).toMatchObject({ memoryMode: "on" });
  });
});
