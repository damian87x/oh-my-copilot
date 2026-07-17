import { execFileSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  atomicWriteTrustedFile,
  atomicWrite,
  ensureDir,
  openRegularFile,
  readJSON,
} from "../../src/utils/fs.js";

const testRoot = mkdtempSync(join(tmpdir(), "omp-utils-fs-"));

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

afterEach(() => {
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

describe.skipIf(process.platform === "win32")("atomicWriteTrustedFile", () => {
  it("replaces a trusted regular file only after staging complete content", () => {
    mkdirSync(testRoot, { recursive: true });
    const target = join(testRoot, "state.json");
    writeFileSync(target, "old\n");

    atomicWriteTrustedFile(target, "new\n", { trustedRoot: testRoot });

    expect(readFileSync(target, "utf8")).toBe("new\n");
  });

  it("preserves the current file when a replacement cannot be staged", () => {
    mkdirSync(testRoot, { recursive: true });
    const target = join(testRoot, "state.json");
    writeFileSync(target, "old\n");
    chmodSync(testRoot, 0o500);

    try {
      expect(() =>
        atomicWriteTrustedFile(target, "new\n", {
          trustedRoot: testRoot,
        }),
      ).toThrow();
      expect(readFileSync(target, "utf8")).toBe("old\n");
    } finally {
      chmodSync(testRoot, 0o700);
    }
  });

  it("rejects a symlink target without changing its external file", () => {
    mkdirSync(testRoot, { recursive: true });
    const external = join(testRoot, "external.json");
    const target = join(testRoot, "state.json");
    writeFileSync(external, "external\n");
    symlinkSync(external, target);

    expect(() =>
      atomicWriteTrustedFile(target, "new\n", { trustedRoot: testRoot }),
    ).toThrow();
    expect(readFileSync(external, "utf8")).toBe("external\n");
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

describe.skipIf(process.platform === "win32")("openRegularFile", () => {
  it("rejects a FIFO without waiting for a writer", () => {
    mkdirSync(testRoot, { recursive: true });
    const fifo = join(testRoot, "evidence.fifo");
    execFileSync("mkfifo", [fifo]);

    const startedAt = Date.now();
    const opened = openRegularFile(fifo, constants.O_RDONLY);

    if (opened.ok) closeSync(opened.fd);
    expect(opened).toEqual({ ok: false, reason: "not-regular" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects multiply-linked files when requested", () => {
    mkdirSync(testRoot, { recursive: true });
    const original = join(testRoot, "original.jsonl");
    const linked = join(testRoot, "linked.jsonl");
    writeFileSync(original, "approval\n");
    linkSync(original, linked);

    const opened = openRegularFile(linked, constants.O_RDONLY, {
      rejectHardlinks: true,
    });

    if (opened.ok) closeSync(opened.fd);
    expect(opened).toEqual({ ok: false, reason: "hardlink" });
  });

  it("rejects a symlinked ancestor inside the trusted root", () => {
    const trustedRoot = join(testRoot, "trusted");
    const outside = join(testRoot, "outside");
    mkdirSync(trustedRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "approvals.jsonl"), "approval\n");
    symlinkSync(outside, join(trustedRoot, "linked"), "dir");

    const opened = openRegularFile(
      join(trustedRoot, "linked", "approvals.jsonl"),
      constants.O_RDONLY,
      { trustedRoot },
    );

    if (opened.ok) closeSync(opened.fd);
    expect(opened).toEqual({ ok: false, reason: "symlink-ancestor" });
  });
});
