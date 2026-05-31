import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stateClear, stateList, stateRead, stateStatus, stateWrite } from "../src/state.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-state-"));

describe("state kv (src/state)", () => {
  it("reads null for a missing key", () => {
    expect(stateRead(cwd(), "nope")).toBeNull();
  });

  it("writes, reads, lists, and clears", () => {
    const root = cwd();
    stateWrite(root, "a", { n: 1 });
    stateWrite(root, "b", "hello");
    expect(stateRead(root, "a")).toEqual({ n: 1 });
    expect(stateRead(root, "b")).toBe("hello");
    expect(stateList(root)).toEqual(["a", "b"]);
    stateClear(root, "a");
    expect(stateRead(root, "a")).toBeNull();
    expect(stateList(root)).toEqual(["b"]);
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
