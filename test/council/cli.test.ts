import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseModelsFlag, parsePositiveIntFlag, runCli } from "../../src/cli.js";
import type { CouncilRunResult } from "../../src/council/types.js";

describe("parseModelsFlag", () => {
  it("parses long-form model:role:weight", () => {
    expect(parseModelsFlag("gpt-5-mini:architect:0.5")).toEqual([
      { model: "gpt-5-mini", role: "architect", weight: 0.5 },
    ]);
  });

  it("parses bare model tokens with round-robin default roles", () => {
    const out = parseModelsFlag("a,b,c,d");
    expect(out.map((m) => m.model)).toEqual(["a", "b", "c", "d"]);
    expect(out.map((m) => m.role)).toEqual(["critic", "architect", "pragmatist", "critic"]);
    expect(out.every((m) => m.weight === 1)).toBe(true);
  });

  it("parses mixed bare + long-form", () => {
    const out = parseModelsFlag("a,b:critic:2");
    expect(out[0]).toEqual({ model: "a", role: "critic", weight: 1 });
    expect(out[1]).toEqual({ model: "b", role: "critic", weight: 2 });
  });

  it("rejects empty and malformed weights", () => {
    expect(() => parseModelsFlag("")).toThrow();
    expect(() => parseModelsFlag("a:critic:notanumber")).toThrow();
    expect(() => parseModelsFlag("a:critic:-1")).toThrow();
  });
});

describe("parsePositiveIntFlag", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parsePositiveIntFlag(undefined, "--timeout")).toBeUndefined();
  });
  it("parses a valid positive integer", () => {
    expect(parsePositiveIntFlag("3", "--min-survivors")).toBe(3);
  });
  it("rejects NaN / non-finite / non-positive / non-integer", () => {
    expect(() => parsePositiveIntFlag("abc", "--min-survivors")).toThrow(/Invalid --min-survivors/);
    expect(() => parsePositiveIntFlag("0", "--min-survivors")).toThrow();
    expect(() => parsePositiveIntFlag("-2", "--min-survivors")).toThrow();
    expect(() => parsePositiveIntFlag("1.5", "--min-survivors")).toThrow();
  });
});

describe("omp council CLI (stub bin)", () => {
  let dir: string;
  let stub: string;
  const saved = { bin: process.env.OMP_COPILOT_BIN };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-council-"));
    stub = join(dir, "stub-copilot");
    // Stub branches on the -p prompt: synth vs member, emitting sentinel JSON.
    writeFileSync(
      stub,
      '#!/usr/bin/env node\n' +
        'const a = process.argv.slice(2);\n' +
        'const pi = a.indexOf("-p");\n' +
        'const prompt = pi >= 0 ? a[pi + 1] : "";\n' +
        'if (prompt.includes("You are the synthesizer")) {\n' +
        '  process.stdout.write(\'<<<JSON>>>{"verdict":"SHIP","confidence":0.9,"rationale":"merged","minority_report":""}<<<END>>>\');\n' +
        '} else {\n' +
        '  process.stdout.write(\'<<<JSON>>>{"verdict":"ok","confidence":0.8,"rationale":"r"}<<<END>>>\');\n' +
        '}\n',
    );
    chmodSync(stub, 0o755);
    process.env.OMP_COPILOT_BIN = stub;
  });

  afterEach(() => {
    if (saved.bin === undefined) delete process.env.OMP_COPILOT_BIN;
    else process.env.OMP_COPILOT_BIN = saved.bin;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the council end-to-end and returns a JSON result", async () => {
    const result = await runCli([
      "council",
      "Should we adopt X?",
      "--models",
      "m1:critic:1,m2:architect:1",
      "--synth",
      "synth",
      "--tmp-dir",
      join(dir, "artifacts"),
      "--json",
    ]);
    expect(result.ok).toBe(true);
    const out = result.output as CouncilRunResult;
    expect(out.survivors).toBe(2);
    expect(out.synth?.verdict).toBe("SHIP");
  });

  it("errors clearly when no question is given", async () => {
    const result = await runCli(["council", "--json"]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/requires a question/i);
  });

  it("errors on malformed --models", async () => {
    const result = await runCli(["council", "Q?", "--models", "a:critic:bad"]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/Invalid --models/);
  });

  it("errors on malformed --min-survivors instead of bypassing the survivor gate", async () => {
    const result = await runCli(["council", "Q?", "--min-survivors", "abc"]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/Invalid --min-survivors/);
  });
});
