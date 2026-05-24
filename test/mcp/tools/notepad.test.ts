import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { notepadTools } from "../../../src/mcp/tools/notepad.js";

const byName = (name: string) => notepadTools.find((t) => t.name === name)!;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-notepad-"));

describe("notepad tools", () => {
  it("writes each section and reads them back independently", async () => {
    const root = cwd();
    await byName("notepad_write_priority").handler({ text: "P1 P2", cwd: root });
    await byName("notepad_write_working").handler({ text: "W1", cwd: root });
    await byName("notepad_write_manual").handler({ text: "M1", cwd: root });

    const priority = await byName("notepad_read").handler({ section: "priority", cwd: root });
    expect(priority.content[0]!.text).toContain("P1 P2");
    const working = await byName("notepad_read").handler({ section: "working", cwd: root });
    expect(working.content[0]!.text).toContain("W1");
    const manual = await byName("notepad_read").handler({ section: "manual", cwd: root });
    expect(manual.content[0]!.text).toContain("M1");

    const all = await byName("notepad_read").handler({ section: "all", cwd: root });
    expect(all.content[0]!.text).toContain("## priority");
    expect(all.content[0]!.text).toContain("## working");
    expect(all.content[0]!.text).toContain("## manual");
  });

  it("prunes all sections", async () => {
    const root = cwd();
    await byName("notepad_write_priority").handler({ text: "P1", cwd: root });
    await byName("notepad_prune").handler({ cwd: root });
    const priority = await byName("notepad_read").handler({ section: "priority", cwd: root });
    expect(priority.content[0]!.text).toBe("");
  });

  it("returns stats including line count", async () => {
    const root = cwd();
    await byName("notepad_write_working").handler({ text: "L1\nL2\nL3", cwd: root });
    const stats = await byName("notepad_stats").handler({ cwd: root });
    const parsed = JSON.parse(stats.content[0]!.text);
    expect(parsed.exists).toBe(true);
    expect(parsed.lineCount).toBeGreaterThan(2);
  });
});
