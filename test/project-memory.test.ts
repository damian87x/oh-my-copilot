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

describe("recentNotes (newest-first, capped)", () => {
  it("returns notes ordered newest-first by mtime, capped to the limit", async () => {
    const { recentNotes } = await import("../src/project-memory.js");
    const { utimesSync } = await import("node:fs");
    const root = cwd();
    addNote(root, "Oldest");
    addNote(root, "Middle");
    addNote(root, "Newest");
    const notesDir = path.join(root, ".omp", "memory", "notes");
    utimesSync(path.join(notesDir, "oldest.md"), new Date(1000), new Date(1000));
    utimesSync(path.join(notesDir, "middle.md"), new Date(2000), new Date(2000));
    utimesSync(path.join(notesDir, "newest.md"), new Date(3000), new Date(3000));
    expect(recentNotes(root, 2).map((n) => n.title)).toEqual(["Newest", "Middle"]);
    expect(recentNotes(root).length).toBe(3); // no limit = all
  });

  it("returns empty when there are no notes", async () => {
    const { recentNotes } = await import("../src/project-memory.js");
    expect(recentNotes(cwd())).toEqual([]);
  });
});

describe("pruneNotes", () => {
  it("keeps the N newest notes and removes the rest", async () => {
    const { pruneNotes, recentNotes } = await import("../src/project-memory.js");
    const { utimesSync } = await import("node:fs");
    const root = cwd();
    addNote(root, "A");
    addNote(root, "B");
    addNote(root, "C");
    const notesDir = path.join(root, ".omp", "memory", "notes");
    utimesSync(path.join(notesDir, "a.md"), new Date(1000), new Date(1000));
    utimesSync(path.join(notesDir, "b.md"), new Date(2000), new Date(2000));
    utimesSync(path.join(notesDir, "c.md"), new Date(3000), new Date(3000));
    const removed = pruneNotes(root, { keep: 2 });
    expect(removed).toEqual(["a"]); // oldest removed
    expect(recentNotes(root).map((n) => n.title)).toEqual(["C", "B"]);
  });

  it("removes notes older than N days", async () => {
    const { pruneNotes, noteIndex } = await import("../src/project-memory.js");
    const { utimesSync } = await import("node:fs");
    const root = cwd();
    addNote(root, "Old");
    addNote(root, "Fresh");
    const notesDir = path.join(root, ".omp", "memory", "notes");
    const old = new Date(Date.now() - 40 * 86400_000);
    utimesSync(path.join(notesDir, "old.md"), old, old);
    const removed = pruneNotes(root, { olderThanDays: 30 });
    expect(removed).toEqual(["old"]);
    expect(noteIndex(root).map((n) => n.id)).toEqual(["fresh"]);
  });

  it("is a no-op with no options", async () => {
    const { pruneNotes, noteIndex } = await import("../src/project-memory.js");
    const root = cwd();
    addNote(root, "Keep me");
    expect(pruneNotes(root, {})).toEqual([]);
    expect(noteIndex(root)).toHaveLength(1);
  });
});
