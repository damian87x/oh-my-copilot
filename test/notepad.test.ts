import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { notepadPrune, notepadRead, notepadStats, notepadWrite } from "../src/notepad.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-np-"));

describe("notepad (src/notepad)", () => {
  it("reads empty when absent", () => {
    expect(notepadRead(cwd(), "all")).toBe("");
  });

  it("writes a section and reads it back, others stay empty", () => {
    const root = cwd();
    notepadWrite(root, "working", "current task");
    expect(notepadRead(root, "working")).toBe("current task");
    expect(notepadRead(root, "priority")).toBe("");
    expect(notepadRead(root, "all")).toContain("## working\ncurrent task");
  });

  it("prunes all sections", () => {
    const root = cwd();
    notepadWrite(root, "priority", "keep an eye");
    notepadPrune(root);
    expect(notepadRead(root, "priority")).toBe("");
  });

  it("reports stats", () => {
    const root = cwd();
    expect(notepadStats(root)).toEqual({ exists: false });
    notepadWrite(root, "manual", "note");
    expect(notepadStats(root).exists).toBe(true);
  });
});
