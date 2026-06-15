import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, ensureDir, readJSON } from "../../src/utils/fs.js";

const testRoot = join(process.cwd(), "test-tmp", "utils-fs");

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes string content atomically", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "test.txt");
    atomicWrite(path, "hello world");
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("writes buffer content atomically", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "test.bin");
    const buf = Buffer.from([1, 2, 3]);
    atomicWrite(path, buf);
    expect(readFileSync(path)).toEqual(buf);
  });

  it("overwrites existing file atomically", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "test.txt");
    atomicWrite(path, "first");
    atomicWrite(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("leaves no temporary files after success", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "test.txt");
    atomicWrite(path, "content");
    const files = readdirSync(testRoot);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("ensureDir", () => {
  it("creates parent directory if it does not exist", () => {
    const path = join(testRoot, "nested", "deep", "file.txt");
    ensureDir(path);
    expect(existsSync(join(testRoot, "nested", "deep"))).toBe(true);
  });

  it("does nothing if directory already exists", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "file.txt");
    ensureDir(path);
    expect(existsSync(testRoot)).toBe(true);
  });

  it("handles path to file in existing directory", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "file.txt");
    ensureDir(path);
    expect(existsSync(testRoot)).toBe(true);
  });
});

describe("readJSON", () => {
  it("reads and parses valid JSON file", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "data.json");
    atomicWrite(path, JSON.stringify({ foo: "bar", num: 42 }));
    const result = readJSON<{ foo: string; num: number }>(path, { foo: "", num: 0 });
    expect(result).toEqual({ foo: "bar", num: 42 });
  });

  it("returns fallback when file does not exist", () => {
    const path = join(testRoot, "missing.json");
    const fallback = { default: true };
    const result = readJSON(path, fallback);
    expect(result).toEqual(fallback);
  });

  it("returns fallback when JSON is invalid", () => {
    mkdirSync(testRoot, { recursive: true });
    const path = join(testRoot, "bad.json");
    atomicWrite(path, "not valid json");
    const fallback = { error: "fallback" };
    const result = readJSON(path, fallback);
    expect(result).toEqual(fallback);
  });

  it("handles empty object as fallback", () => {
    const path = join(testRoot, "missing.json");
    const result = readJSON(path, {});
    expect(result).toEqual({});
  });
});
