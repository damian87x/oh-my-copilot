import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs hook script, no types
import { handleSessionStart } from "../../scripts/session-start.mjs";
// @ts-expect-error — plain .mjs hook helper, no types
import { readDirectiveCaps } from "../../scripts/lib/memory-config.mjs";
// @ts-expect-error — plain .mjs hook helper, no types
import { notesSummary } from "../../scripts/lib/notes-index.mjs";

const root = () => mkdtempSync(path.join(tmpdir(), "omp-ss-mem-"));

async function startContext(cwd: string): Promise<string> {
  const out = await handleSessionStart(JSON.stringify({ sessionId: "t-session", cwd }));
  return out.additionalContext ?? "";
}

function writeDirectives(cwd: string, directives: string[]): void {
  mkdirSync(path.join(cwd, ".omp"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".omp", "project-memory.json"),
    JSON.stringify({ directives, updatedAt: new Date().toISOString() }),
    "utf8",
  );
}

function writeNote(cwd: string, file: string, title: string): void {
  const dir = path.join(cwd, ".omp", "memory", "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), `# ${title}\n\nbody stays on disk\n`, "utf8");
}

const savedOverride = process.env.OMP_VERSION_OVERRIDE;

afterEach(() => {
  if (savedOverride === undefined) delete process.env.OMP_VERSION_OVERRIDE;
  else process.env.OMP_VERSION_OVERRIDE = savedOverride;
});

describe("session-start memory injection", () => {
  it("injects directives and a notes breadcrumb with newest titles (bodies stay on disk)", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0"; // hermetic: no update notice
    const cwd = root();
    writeDirectives(cwd, ["always run tests"]);
    writeNote(cwd, "auth.md", "Auth lives in src/auth");
    writeNote(cwd, "db.md", "DB schema notes");
    const ctx = await startContext(cwd);
    expect(ctx).toContain("[DIRECTIVES]");
    expect(ctx).toContain("- always run tests");
    expect(ctx).toContain("[MEMORY] 2 notes in project memory");
    expect(ctx).toContain("Auth lives in src/auth");
    expect(ctx).toContain("omp project-memory read");
    expect(ctx).not.toContain("body stays on disk");
  });

  it("honors memory-directive-cap from project config and points at the overflow", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0";
    const cwd = root();
    writeDirectives(cwd, ["rule one", "rule two", "rule three"]);
    writeFileSync(
      path.join(cwd, ".omp", "config.json"),
      JSON.stringify({ memoryDirectiveCap: "2" }),
      "utf8",
    );
    const ctx = await startContext(cwd);
    expect(ctx).toContain("- rule one");
    expect(ctx).toContain("- rule two");
    expect(ctx).not.toContain("- rule three");
    expect(ctx).toContain("(+1 more");
  });

  it("injects no memory sections when stores are empty", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0";
    const cwd = root();
    const ctx = await startContext(cwd);
    expect(ctx).not.toContain("[DIRECTIVES]");
    expect(ctx).not.toContain("[MEMORY]");
  });
});

describe("readDirectiveCaps (.mjs hook config)", () => {
  it("defaults to 12 / 1200 with no config files", () => {
    expect(readDirectiveCaps(root())).toEqual({ directiveCap: 12, directiveCharCap: 1200 });
  });

  it("project config overrides global, per key", () => {
    const cwd = root();
    const home = root();
    const prev = process.env.OMP_HOME_OVERRIDE;
    process.env.OMP_HOME_OVERRIDE = home;
    try {
      mkdirSync(path.join(home, ".omp"), { recursive: true });
      writeFileSync(
        path.join(home, ".omp", "config.json"),
        JSON.stringify({ memoryDirectiveCap: "20", memoryDirectiveCharCap: "4000" }),
        "utf8",
      );
      mkdirSync(path.join(cwd, ".omp"), { recursive: true });
      writeFileSync(path.join(cwd, ".omp", "config.json"), JSON.stringify({ memoryDirectiveCap: "7" }), "utf8");
      expect(readDirectiveCaps(cwd)).toEqual({ directiveCap: 7, directiveCharCap: 4000 });
    } finally {
      if (prev === undefined) delete process.env.OMP_HOME_OVERRIDE;
      else process.env.OMP_HOME_OVERRIDE = prev;
    }
  });
});

describe("notesSummary (.mjs hook notes index)", () => {
  it("returns total + at most 3 titles, empty when no notes dir", () => {
    const cwd = root();
    expect(notesSummary(cwd)).toEqual({ total: 0, titles: [] });
    for (let i = 1; i <= 5; i++) writeNote(cwd, `n${i}.md`, `Title ${i}`);
    const summary = notesSummary(cwd);
    expect(summary.total).toBe(5);
    expect(summary.titles).toHaveLength(3);
  });

  it("truncates long titles", () => {
    const cwd = root();
    writeNote(cwd, "long.md", `A ${"x".repeat(100)}`);
    const [title] = notesSummary(cwd).titles;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title).toContain("…");
  });
});
