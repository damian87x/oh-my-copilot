import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDirective, addNote, noteIndex, readDirectives, readNote } from "../src/project-memory.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-pm-"));

describe("project memory: directives (injected)", () => {
  it("starts empty and appends", () => {
    const root = cwd();
    expect(readDirectives(root)).toEqual([]);
    expect(addDirective(root, "always run tests")).toBe(1);
    expect(addDirective(root, "never push to main")).toBe(2);
    expect(readDirectives(root)).toEqual(["always run tests", "never push to main"]);
  });
});

describe("project memory: notes (progressive disclosure)", () => {
  it("adds a note and surfaces only id+title in the index", () => {
    const root = cwd();
    const id = addNote(root, "Auth lives in src/auth", "AuthService.verify() checks the JWT; see middleware.ts");
    expect(id).toBe("auth-lives-in-src-auth");
    const idx = noteIndex(root);
    expect(idx).toEqual([{ id: "auth-lives-in-src-auth", title: "Auth lives in src/auth" }]);
    // index entry has NO body — that only comes from readNote
    expect(JSON.stringify(idx)).not.toContain("AuthService");
  });

  it("loads a note body on demand by id", () => {
    const root = cwd();
    const id = addNote(root, "DB schema", "users(id, email); sessions(id, user_id)");
    const note = readNote(root, id);
    expect(note).toContain("# DB schema");
    expect(note).toContain("users(id, email)");
    expect(readNote(root, "missing")).toBeNull();
  });

  it("rejects a path-traversal id on read", () => {
    const root = cwd();
    addNote(root, "Safe note");
    expect(readNote(root, "../../../etc/passwd")).toBeNull();
    expect(readNote(root, "safe/note")).toBeNull();
    expect(readNote(root, "safe-note")).toContain("# Safe note"); // the real one still loads
  });

  it("dedupes ids when titles collide", () => {
    const root = cwd();
    expect(addNote(root, "Note")).toBe("note");
    expect(addNote(root, "Note")).toBe("note-2");
    expect(noteIndex(root).map((n) => n.id)).toEqual(["note", "note-2"]);
  });
});
