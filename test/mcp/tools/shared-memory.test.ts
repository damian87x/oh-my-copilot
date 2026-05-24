import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedMemoryTools } from "../../../src/mcp/tools/shared-memory.js";

const byName = (name: string) => sharedMemoryTools.find((t) => t.name === name)!;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-sm-"));

function parsed(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

describe("shared-memory tools", () => {
  it("write + read round-trips", async () => {
    const root = cwd();
    await byName("shared_memory_write").handler({ key: "alpha", value: { x: 1 }, cwd: root });
    const read = await byName("shared_memory_read").handler({ key: "alpha", cwd: root });
    expect(parsed(read).value).toEqual({ x: 1 });
  });

  it("returns null for missing keys", async () => {
    const root = cwd();
    const read = await byName("shared_memory_read").handler({ key: "nope", cwd: root });
    expect(parsed(read).value).toBeNull();
  });

  it("lists + deletes entries", async () => {
    const root = cwd();
    await byName("shared_memory_write").handler({ key: "a", value: 1, cwd: root });
    await byName("shared_memory_write").handler({ key: "b", value: 2, cwd: root });
    const list = await byName("shared_memory_list").handler({ cwd: root });
    expect(parsed(list).keys.sort()).toEqual(["a", "b"]);
    await byName("shared_memory_delete").handler({ key: "a", cwd: root });
    const list2 = await byName("shared_memory_list").handler({ cwd: root });
    expect(parsed(list2).keys).toEqual(["b"]);
  });

  it("TTL expires and cleanup removes expired entries", async () => {
    const root = cwd();
    await byName("shared_memory_write").handler({ key: "ephemeral", value: 1, ttlSeconds: -1, cwd: root });
    const cleanup = await byName("shared_memory_cleanup").handler({ cwd: root });
    expect(parsed(cleanup).deleted).toBe(1);
    const list = await byName("shared_memory_list").handler({ cwd: root });
    expect(parsed(list).keys).toEqual([]);
  });
});
