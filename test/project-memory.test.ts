import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProjectDirective, addProjectNote, readProjectMemory } from "../src/project-memory.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-pm-"));

describe("project memory (src/project-memory)", () => {
  it("starts empty", () => {
    const m = readProjectMemory(cwd());
    expect(m.notes).toEqual([]);
    expect(m.directives).toEqual([]);
  });

  it("appends notes and directives, tracking counts", () => {
    const root = cwd();
    expect(addProjectNote(root, "first note")).toBe(1);
    expect(addProjectNote(root, "second note")).toBe(2);
    expect(addProjectDirective(root, "always test")).toBe(1);
    const m = readProjectMemory(root);
    expect(m.notes).toEqual(["first note", "second note"]);
    expect(m.directives).toEqual(["always test"]);
    expect(m.updatedAt).toBeTruthy();
  });
});
