import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectMemoryTools } from "../../../src/mcp/tools/project-memory.js";

const byName = (name: string) => projectMemoryTools.find((t) => t.name === name)!;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-pm-"));

describe("project-memory tools", () => {
  it("starts empty, accepts add_note + add_directive, and reads back", async () => {
    const root = cwd();
    let read = await byName("project_memory_read").handler({ cwd: root });
    expect(JSON.parse(read.content[0]!.text)).toMatchObject({ notes: [], directives: [] });

    await byName("project_memory_add_note").handler({ note: "first note", cwd: root });
    await byName("project_memory_add_note").handler({ note: "second note", cwd: root });
    await byName("project_memory_add_directive").handler({ directive: "always test", cwd: root });

    read = await byName("project_memory_read").handler({ cwd: root });
    const parsed = JSON.parse(read.content[0]!.text);
    expect(parsed.notes).toEqual(["first note", "second note"]);
    expect(parsed.directives).toEqual(["always test"]);
    expect(parsed.updatedAt).toBeTruthy();
  });

  it("replaces wholesale via project_memory_write", async () => {
    const root = cwd();
    await byName("project_memory_add_note").handler({ note: "to be replaced", cwd: root });
    await byName("project_memory_write").handler({ notes: ["only one"], cwd: root });
    const read = await byName("project_memory_read").handler({ cwd: root });
    expect(JSON.parse(read.content[0]!.text).notes).toEqual(["only one"]);
  });
});
