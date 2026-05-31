import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedCleanup, sharedDelete, sharedList, sharedRead, sharedWrite } from "../src/shared-memory.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-sm-"));

describe("shared memory (src/shared-memory)", () => {
  it("writes, reads, lists, and deletes", () => {
    const root = cwd();
    sharedWrite(root, "k", { a: 1 });
    expect(sharedRead(root, "k").value).toEqual({ a: 1 });
    expect(sharedList(root)).toEqual(["k"]);
    sharedDelete(root, "k");
    expect(sharedRead(root, "k").value).toBeNull();
  });

  it("returns null for a missing key", () => {
    expect(sharedRead(cwd(), "missing").value).toBeNull();
  });

  it("expires entries past their TTL and cleans them up", () => {
    const root = cwd();
    sharedWrite(root, "ephemeral", "x", -1); // already expired
    const read = sharedRead(root, "ephemeral");
    expect(read.value).toBeNull();
    expect(read.expired).toBe(true);
    sharedWrite(root, "ephemeral2", "y", -1);
    expect(sharedCleanup(root)).toBe(1);
    expect(sharedList(root)).toEqual([]);
  });
});
