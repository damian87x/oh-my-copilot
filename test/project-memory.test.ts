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

// --- Topic-based durable memory tests ---

describe("topic memory: CRUD operations", () => {
  it("adds facts to a new topic and reads them back", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(addTopicFact(root, "auth", "JWT is used for authentication")).toBe(true);
    expect(addTopicFact(root, "auth", "Token refresh endpoint is /auth/refresh")).toBe(true);
    const topic = readTopicMemory(root, "auth");
    expect(topic).not.toBeNull();
    expect(topic?.topic).toBe("auth");
    expect(topic?.facts).toEqual([
      "JWT is used for authentication",
      "Token refresh endpoint is /auth/refresh",
    ]);
  });

  it("rejects invalid topic ids (path traversal, invalid chars)", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(addTopicFact(root, "../../../etc/passwd", "hacked")).toBe(false);
    expect(addTopicFact(root, "auth/config", "bad")).toBe(false);
    expect(addTopicFact(root, "auth config", "bad")).toBe(false);
    expect(readTopicMemory(root, "../evil")).toBeNull();
  });

  it("accepts valid slug topic ids", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(addTopicFact(root, "auth", "fact1")).toBe(true);
    expect(addTopicFact(root, "user-model", "fact2")).toBe(true);
    expect(addTopicFact(root, "api-v2-routes", "fact3")).toBe(true);
    expect(readTopicMemory(root, "auth")?.facts).toContain("fact1");
    expect(readTopicMemory(root, "user-model")?.facts).toContain("fact2");
    expect(readTopicMemory(root, "api-v2-routes")?.facts).toContain("fact3");
  });

  it("prevents duplicate facts", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(addTopicFact(root, "db", "PostgreSQL is used")).toBe(true);
    expect(addTopicFact(root, "db", "PostgreSQL is used")).toBe(false);
    expect(readTopicMemory(root, "db")?.facts.length).toBe(1);
  });

  it("lists all topics", async () => {
    const {
      addTopicFact,
      listTopicMemories,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(listTopicMemories(root)).toEqual([]);
    addTopicFact(root, "zebra", "z");
    addTopicFact(root, "apple", "a");
    addTopicFact(root, "middle", "m");
    expect(listTopicMemories(root)).toEqual(["apple", "middle", "zebra"]); // sorted
  });

  it("returns null for non-existent topics", async () => {
    const {
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(readTopicMemory(root, "missing")).toBeNull();
  });
});

describe("topic memory: fact removal", () => {
  it("removes a fact by index", async () => {
    const {
      addTopicFact,
      removeTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    addTopicFact(root, "db", "fact1");
    addTopicFact(root, "db", "fact2");
    addTopicFact(root, "db", "fact3");
    expect(removeTopicFact(root, "db", 1)).toBe(true);
    expect(readTopicMemory(root, "db")?.facts).toEqual(["fact1", "fact3"]);
  });

  it("rejects invalid indices", async () => {
    const {
      addTopicFact,
      removeTopicFact,
    } = await import("../src/project-memory.js");
    const root = cwd();
    addTopicFact(root, "db", "fact1");
    expect(removeTopicFact(root, "db", -1)).toBe(false);
    expect(removeTopicFact(root, "db", 10)).toBe(false);
    expect(removeTopicFact(root, "db", 0)).toBe(true);
    expect(removeTopicFact(root, "db", 0)).toBe(false); // now empty
  });

  it("rejects removal on non-existent topic", async () => {
    const {
      removeTopicFact,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(removeTopicFact(root, "missing", 0)).toBe(false);
  });
});

describe("topic memory: consolidation", () => {
  it("consolidates facts and returns summary", async () => {
    const {
      addTopicFact,
      consolidateTopicFacts,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    addTopicFact(root, "arch", "React frontend");
    addTopicFact(root, "arch", "Node.js backend");
    addTopicFact(root, "arch", "PostgreSQL database");
    const result = consolidateTopicFacts(root, "arch", [
      "React frontend",
      "Express.js backend",
    ]);
    expect(result?.merged).toBe(2);
    expect(result?.kept).toBe(1);
    expect(readTopicMemory(root, "arch")?.facts).toEqual([
      "React frontend",
      "Express.js backend",
    ]);
  });

  it("returns null for invalid topic or non-existent topic", async () => {
    const {
      consolidateTopicFacts,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(consolidateTopicFacts(root, "../evil", [])).toBeNull();
    expect(consolidateTopicFacts(root, "missing", [])).toBeNull();
  });
});

describe("topic memory: promotion to durable memory", () => {
  it("promotes facts from one topic to another", async () => {
    const {
      addTopicFact,
      promoteToDurableMemory,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    addTopicFact(root, "session", "Auth done via JWT");
    addTopicFact(root, "session", "Tokens expire in 1h");
    addTopicFact(root, "session", "Refresh tokens in DB");
    const result = promoteToDurableMemory(root, "session", "auth", [
      "Auth done via JWT",
      "Tokens expire in 1h",
    ]);
    expect(result?.promotedCount).toBe(2);
    expect(result?.targetTopic).toBe("auth");
    expect(readTopicMemory(root, "auth")?.facts).toEqual([
      "Auth done via JWT",
      "Tokens expire in 1h",
    ]);
    expect(readTopicMemory(root, "session")?.facts).toEqual([
      "Refresh tokens in DB",
    ]);
  });

  it("rejects invalid topic ids", async () => {
    const {
      promoteToDurableMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    expect(promoteToDurableMemory(root, "../evil", "auth", [])).toBeNull();
    expect(promoteToDurableMemory(root, "session", "../evil", [])).toBeNull();
  });

  it("returns 0 promoted when source topic missing", async () => {
    const {
      promoteToDurableMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    const result = promoteToDurableMemory(root, "missing", "auth", ["fact"]);
    expect(result).toBeNull();
  });
});

describe("topic memory: atomic writes", () => {
  it("writes facts atomically using tmp → rename", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const { existsSync } = await import("node:fs");
    const root = cwd();
    const topicsDir = path.join(root, ".omp", "memory", "topics");
    addTopicFact(root, "test", "fact1");
    expect(existsSync(path.join(topicsDir, "test.json"))).toBe(true);
    // Verify no .tmp files exist (atomic write completed)
    const files = (await import("node:fs")).readdirSync(topicsDir);
    expect(files.every((f) => !f.includes(".tmp"))).toBe(true);
    const memo = readTopicMemory(root, "test");
    expect(memo?.facts).toContain("fact1");
  });

  it("preserves facts across multiple writes", async () => {
    const {
      addTopicFact,
      readTopicMemory,
    } = await import("../src/project-memory.js");
    const root = cwd();
    addTopicFact(root, "persist", "fact1");
    addTopicFact(root, "persist", "fact2");
    addTopicFact(root, "persist", "fact3");
    const first = readTopicMemory(root, "persist");
    addTopicFact(root, "persist", "fact4");
    const second = readTopicMemory(root, "persist");
    expect(first?.facts).toEqual(["fact1", "fact2", "fact3"]);
    expect(second?.facts).toEqual(["fact1", "fact2", "fact3", "fact4"]);
  });
});
