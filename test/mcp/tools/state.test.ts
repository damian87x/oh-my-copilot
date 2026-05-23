import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stateTools } from "../../../src/mcp/tools/state.js";

function tempCwd() {
  return mkdtempSync(path.join(tmpdir(), "omc-state-tools-"));
}

const byName = (name: string) => stateTools.find((t) => t.name === name)!;

describe("state tools", () => {
  it("round-trips a value through write + read", async () => {
    const cwd = tempCwd();
    const write = await byName("state_write").handler({ key: "alpha", value: { x: 1 }, cwd });
    expect(write.isError).toBeFalsy();
    const read = await byName("state_read").handler({ key: "alpha", cwd });
    expect(JSON.parse(read.content[0]!.text)).toEqual({ value: { x: 1 } });
  });

  it("returns null for unknown keys", async () => {
    const cwd = tempCwd();
    const read = await byName("state_read").handler({ key: "missing", cwd });
    expect(JSON.parse(read.content[0]!.text)).toEqual({ value: null });
  });

  it("clears a key", async () => {
    const cwd = tempCwd();
    await byName("state_write").handler({ key: "alpha", value: 1, cwd });
    await byName("state_clear").handler({ key: "alpha", cwd });
    const read = await byName("state_read").handler({ key: "alpha", cwd });
    expect(JSON.parse(read.content[0]!.text)).toEqual({ value: null });
  });

  it("lists active keys + reports status", async () => {
    const cwd = tempCwd();
    await byName("state_write").handler({ key: "a", value: 1, cwd });
    await byName("state_write").handler({ key: "b", value: 2, cwd });
    const list = await byName("state_list_active").handler({ cwd });
    expect(JSON.parse(list.content[0]!.text).keys).toEqual(["a", "b"]);
    const status = await byName("state_get_status").handler({ key: "a", cwd });
    expect(JSON.parse(status.content[0]!.text).exists).toBe(true);
  });

  it("rejects invalid keys", () => {
    const cwd = tempCwd();
    expect(() => byName("state_write").handler({ key: "../escape", value: 1, cwd })).toThrow(/invalid key/);
  });
});
