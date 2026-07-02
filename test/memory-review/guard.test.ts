import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimSession } from "../../src/memory-review/guard.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-guard-"));

describe("session claim guard", () => {
  it("grants the claim exactly once for a session", () => {
    const cwd = root();
    const uuid = "abc-123";
    expect(claimSession(cwd, uuid)).toBe(true); // first claim wins
    expect(claimSession(cwd, uuid)).toBe(false); // already claimed
  });

  it("two simultaneous claimants yield exactly one winner", () => {
    const cwd = root();
    const results = Array.from({ length: 8 }, () => claimSession(cwd, "race-1"));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("claimSession legacy-claim dedupe when migration cannot move it", () => {
  it("refuses the claim while a legacy claim file for the session still exists", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { claimSession } = await import("../../src/memory-review/guard.js");
    const cwd = mkdtempSync(path.join(tmpdir(), "omc-guard-legacy-"));
    const legacyReview = path.join(cwd, ".oh-my-copilot", "memory-review");
    mkdirSync(legacyReview, { recursive: true });
    writeFileSync(path.join(legacyReview, ".claim-sess-1"), "2026-01-01", "utf8");
    chmodSync(legacyReview, 0o555); // read-only: migration cannot move the claim
    try {
      expect(claimSession(cwd, "sess-1")).toBe(false); // legacy claim still dedupes
    } finally {
      chmodSync(legacyReview, 0o755);
    }
  });
});
