import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchMemory } from "../src/memory-recall.js";
import { addNote, addTopicFact, setTopicDescription } from "../src/project-memory.js";
import { addLogEntry } from "../src/daily-log.js";

const cwd = () => mkdtempSync(path.join(tmpdir(), "omp-recall-"));

describe("memory-recall: bounded search", () => {
  it("searches topic facts before notes and daily logs", () => {
    const root = cwd();
    setTopicDescription(root, "auth", "Authentication strategy");
    addTopicFact(root, "auth", "JWT tokens rotate every hour");
    addNote(root, "Auth note", "JWT note details");

    const results = searchMemory(root, { query: "JWT" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      source: "topic",
      id: "auth",
      title: "Authentication strategy",
    });
    expect(results[0].preview).toContain("JWT tokens");
  });

  it("scopes topic search with options.topic", () => {
    const root = cwd();
    addTopicFact(root, "auth", "JWT tokens rotate every hour");
    addTopicFact(root, "db", "JWT audit records live in PostgreSQL");

    const results = searchMemory(root, { query: "JWT", topic: "db" });

    expect(results.filter((r) => r.source === "topic")).toEqual([
      expect.objectContaining({ source: "topic", id: "db" }),
    ]);
  });
  it("searches notes by query", () => {
    const root = cwd();
    addNote(root, "Database schema", "Tables for users and posts stored in PostgreSQL");
    addNote(root, "Auth implementation", "JWT tokens and refresh logic");

    const results = searchMemory(root, { query: "database" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("note");
    expect(results[0].title).toBe("Database schema");
    expect(results[0].preview).toContain("PostgreSQL");
  });

  it("searches daily logs by query", () => {
    const root = cwd();
    addLogEntry(root, "Implemented user authentication module with JWT");
    addLogEntry(root, "Fixed critical memory leak in event loop");

    const results = searchMemory(root, { query: "authentication" });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source === "daily-log")).toBe(true);
    expect(results[0].title).toMatch(/Daily log:/);
  });

  it("combines note and daily-log results", () => {
    const root = cwd();
    addNote(root, "Performance optimization notes", "Cache strategy for database queries");
    addLogEntry(root, "Performance improvements completed for query caching");

    const results = searchMemory(root, { query: "performance" });

    expect(results.length).toBeGreaterThanOrEqual(2);
    const sources = results.map((r) => r.source);
    expect(sources).toContain("note");
    expect(sources).toContain("daily-log");
  });

  it("respects limit option (default 20)", () => {
    const root = cwd();
    for (let i = 0; i < 30; i++) {
      addNote(root, `Note ${i}`, "content with search term here");
    }

    const results = searchMemory(root, { query: "search", limit: 20 });

    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("enforces maximum limit of 100", () => {
    const root = cwd();
    for (let i = 0; i < 150; i++) {
      addNote(root, `Note ${i}`, "query term in content");
    }

    const results = searchMemory(root, { query: "query", limit: 200 });

    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("filters by keyword", () => {
    const root = cwd();
    addNote(root, "Frontend guide", "React components and hooks");
    addNote(root, "Backend guide", "Node.js and Express setup");

    const frontendResults = searchMemory(root, {
      query: "guide",
      keyword: "react",
    });

    expect(frontendResults.length).toBeGreaterThan(0);
    expect(frontendResults.every((r) => r.preview.toLowerCase().includes("react"))).toBe(true);
  });

  it("filters daily logs by date range", () => {
    const root = cwd();
    const dailyDir = `${root}/.omp/memory/daily`;
    mkdirSync(dailyDir, { recursive: true });

    // Create logs for specific dates
    writeFileSync(
      `${dailyDir}/2024-01-10.md`,
      "# 2024-01-10\n## Goal\nTest goal\n## Log\nOld entry with keyword",
    );
    writeFileSync(
      `${dailyDir}/2024-06-15.md`,
      "# 2024-06-15\n## Goal\nTest goal\n## Log\nRecent entry with keyword",
    );

    const start = new Date("2024-06-01");
    const end = new Date("2024-06-30");

    const results = searchMemory(root, {
      query: "keyword",
      dateRange: { start, end },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.id >= "2024-06-01" && r.id <= "2024-06-30")).toBe(true);
  });

  it("returns results with correct type-safe shape", () => {
    const root = cwd();
    addNote(root, "API spec", "RESTful endpoints documentation");

    const results = searchMemory(root, { query: "API" });

    expect(results.length).toBeGreaterThan(0);
    const result = results[0];

    expect(result).toHaveProperty("source");
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("title");
    expect(result).toHaveProperty("preview");

    expect(typeof result.source).toBe("string");
    expect(typeof result.id).toBe("string");
    expect(typeof result.title).toBe("string");
    expect(typeof result.preview).toBe("string");

    expect(["topic", "note", "daily-log"]).toContain(result.source);
  });

  it("handles empty query gracefully", () => {
    const root = cwd();
    addNote(root, "Test note", "content");

    const results = searchMemory(root, { query: "" });

    expect(results).toEqual([]);
  });

  it("handles whitespace-only query gracefully", () => {
    const root = cwd();
    addNote(root, "Test note", "content");

    const results = searchMemory(root, { query: "   " });

    expect(results).toEqual([]);
  });

  it("performs case-insensitive search", () => {
    const root = cwd();
    addNote(root, "Title", "Database connection pooling");

    const lowerResults = searchMemory(root, { query: "database" });
    const upperResults = searchMemory(root, { query: "DATABASE" });
    const mixedResults = searchMemory(root, { query: "DataBase" });

    expect(lowerResults.length).toBeGreaterThan(0);
    expect(upperResults.length).toBeGreaterThan(0);
    expect(mixedResults.length).toBeGreaterThan(0);
  });

  it("matches multi-word queries", () => {
    const root = cwd();
    addNote(root, "Full text search", "Implementation of FTS in database");

    const results = searchMemory(root, { query: "full text" });

    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty when no matches found", () => {
    const root = cwd();
    addNote(root, "Note", "some content");

    const results = searchMemory(root, { query: "nonexistent" });

    expect(results).toEqual([]);
  });

  it("provides meaningful preview text from notes", () => {
    const root = cwd();
    addNote(
      root,
      "Long document",
      "This is a very long document with lots of information about testing and quality assurance procedures that we follow in the project",
    );

    const results = searchMemory(root, { query: "testing" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].preview.length).toBeGreaterThan(0);
    expect(results[0].preview.length).toBeLessThanOrEqual(250);
  });

  it("provides preview from daily logs", () => {
    const root = cwd();
    addLogEntry(
      root,
      "This was a productive day implementing the search feature across the memory module",
    );

    const results = searchMemory(root, { query: "productive" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].preview).toContain("productive");
  });

  it("does not include body content for keyword filtering", () => {
    const root = cwd();
    addNote(root, "Security", "Password hashing with bcrypt and argon2");
    addNote(root, "Cryptography", "SSL/TLS implementation details");

    const results = searchMemory(root, { query: "security", keyword: "bcrypt" });

    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (r) => r.title.toLowerCase().includes("security") || r.preview.toLowerCase().includes("bcrypt"),
      ),
    ).toBe(true);
  });

  it("result limit prevents unbounded output", () => {
    const root = cwd();
    const baseQuery = "essential";

    // Create many notes with the search term
    for (let i = 0; i < 50; i++) {
      addNote(root, `Essential doc ${i}`, `This is essential information ${i}`);
    }

    const limitedResults = searchMemory(root, { query: baseQuery, limit: 5 });

    expect(limitedResults.length).toBeLessThanOrEqual(5);
    expect(limitedResults.length).toBeGreaterThan(0);
  });

  it("combines multiple sources within limit", () => {
    const root = cwd();

    // Create notes
    addNote(root, "Note 1", "infrastructure setup details");
    addNote(root, "Note 2", "infrastructure monitoring tools");

    // Create log entries
    addLogEntry(root, "Infrastructure deployment completed");
    addLogEntry(root, "Infrastructure health checks passed");

    const results = searchMemory(root, { query: "infrastructure", limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);

    // Should have both sources
    const sources = new Set(results.map((r) => r.source));
    expect(sources.size).toBeGreaterThanOrEqual(1);
  });
});

describe("omp project-memory search (CLI)", () => {
  it("searches topics, notes, and daily logs through one command", async () => {
    const { runCli } = await import("../src/cli.js");
    const root = cwd();
    setTopicDescription(root, "infra", "Infrastructure setup");
    addTopicFact(root, "infra", "Deploys run on Kubernetes");
    addNote(root, "Kubernetes ingress", "nginx ingress handles TLS");
    addLogEntry(root, "Debugged Kubernetes DNS today");

    const res = await runCli(["project-memory", "search", "kubernetes", "--root", root, "--json"]);
    expect(res.ok).toBe(true);
    const results = (res.output as { results: Array<{ source: string }> }).results;
    const sources = new Set(results.map((r) => r.source));
    expect(sources.has("topic")).toBe(true);
    expect(sources.has("note")).toBe(true);
    expect(sources.has("daily-log")).toBe(true);
  });

  it("rejects a missing query", async () => {
    const { runCli } = await import("../src/cli.js");
    const res = await runCli(["project-memory", "search", "--root", cwd()]);
    expect(res.ok).toBe(false);
  });
});
