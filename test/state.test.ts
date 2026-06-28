import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stateCleanup, stateDelete, stateList, stateRead, stateStatus, stateWrite } from "../src/state.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-state-"));

describe("state kv (src/state)", () => {
  it("reads null for a missing key", () => {
    expect(stateRead(cwd(), "nope").value).toBeNull();
  });

  it("writes, reads, lists, and deletes", () => {
    const root = cwd();
    stateWrite(root, "a", { n: 1 });
    stateWrite(root, "b", "hello");
    expect(stateRead(root, "a").value).toEqual({ n: 1 });
    expect(stateRead(root, "b").value).toBe("hello");
    expect(stateList(root)).toEqual(["a", "b"]);
    stateDelete(root, "a");
    expect(stateRead(root, "a").value).toBeNull();
    expect(stateList(root)).toEqual(["b"]);
  });

  it("expires entries past their TTL and cleans them up", () => {
    const root = cwd();
    stateWrite(root, "ephemeral", "x", -1); // already expired
    const read = stateRead(root, "ephemeral");
    expect(read.value).toBeNull();
    expect(read.expired).toBe(true);
    stateWrite(root, "ephemeral2", "y", -1);
    expect(stateCleanup(root)).toBe(1);
    expect(stateList(root)).toEqual([]);
  });

  it("reports status with mtime + bytes", () => {
    const root = cwd();
    expect(stateStatus(root, "x")).toEqual({ exists: false });
    stateWrite(root, "x", 1);
    const st = stateStatus(root, "x");
    expect(st.exists).toBe(true);
    expect(typeof st.bytes).toBe("number");
  });

  it("rejects an invalid key", () => {
    expect(() => stateWrite(cwd(), "bad/key", 1)).toThrow(/invalid key/);
  });
});
