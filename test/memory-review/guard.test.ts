import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimSession, hasClaim } from "../../src/memory-review/guard.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-guard-"));

describe("session claim guard", () => {
  it("grants the claim exactly once for a session", () => {
    const cwd = root();
    const uuid = "abc-123";
    expect(hasClaim(cwd, uuid)).toBe(false);
    expect(claimSession(cwd, uuid)).toBe(true);
    expect(claimSession(cwd, uuid)).toBe(false);
    expect(hasClaim(cwd, uuid)).toBe(true);
  });

  it("two simultaneous claimants yield exactly one winner", () => {
    const cwd = root();
    const results = Array.from({ length: 8 }, () => claimSession(cwd, "race-1"));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
