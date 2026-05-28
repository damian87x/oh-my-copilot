import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error -- .mjs file with no .d.ts; tested through public surface
import { checkForUpdate, formatUpdateNotice, isNewer } from "../../scripts/lib/version-check.mjs";

describe("isNewer", () => {
  it("compares major / minor / patch in priority order", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
    expect(isNewer("1.10.0", "1.9.99")).toBe(true);
    expect(isNewer("1.2.4", "1.2.3")).toBe(true);
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });

  it("returns false on missing or non-numeric input", () => {
    expect(isNewer("", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "")).toBe(false);
    expect(isNewer("abc", "1.0.0")).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  it("includes both versions and the update command", () => {
    const notice = formatUpdateNotice("0.1.1", "0.2.0");
    expect(notice).toContain("v0.1.1");
    expect(notice).toContain("v0.2.0");
    expect(notice).toContain("npm i -g @damian87/omp@latest");
  });
});

describe("checkForUpdate", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "omp-version-check-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns null when latest <= current", async () => {
    const result = await checkForUpdate({
      stateDir,
      fetchLatest: async () => "0.0.1",
    });
    expect(result).toBeNull();
  });

  it("returns {current, latest} when remote is newer and writes cache", async () => {
    const result = await checkForUpdate({
      stateDir,
      now: 1000,
      fetchLatest: async () => "999.0.0",
    });
    expect(result).toMatchObject({ latest: "999.0.0" });
    const cache = JSON.parse(readFileSync(join(stateDir, "version-check.json"), "utf8"));
    expect(cache).toMatchObject({ checkedAt: 1000, latest: "999.0.0" });
  });

  it("reuses cached value within TTL without calling fetchLatest", async () => {
    writeFileSync(
      join(stateDir, "version-check.json"),
      JSON.stringify({ checkedAt: 1000, latest: "999.0.0" }),
    );
    let fetchCalls = 0;
    const result = await checkForUpdate({
      stateDir,
      now: 1000 + 60 * 1000,
      fetchLatest: async () => {
        fetchCalls += 1;
        return "0.0.1";
      },
    });
    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({ latest: "999.0.0" });
  });

  it("refetches when cache is older than TTL", async () => {
    writeFileSync(
      join(stateDir, "version-check.json"),
      JSON.stringify({ checkedAt: 0, latest: "0.0.1" }),
    );
    const result = await checkForUpdate({
      stateDir,
      now: 24 * 60 * 60 * 1000,
      fetchLatest: async () => "999.0.0",
    });
    expect(result).toMatchObject({ latest: "999.0.0" });
  });
});
