import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-cli-"));

/** Run with an isolated global ~/.omp home so memory-mode (now written GLOBAL)
 *  can't leak into other tests sharing setup.ts's OMP_HOME_OVERRIDE. */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const prev = process.env.OMP_HOME_OVERRIDE;
  const home = root();
  process.env.OMP_HOME_OVERRIDE = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.OMP_HOME_OVERRIDE;
    else process.env.OMP_HOME_OVERRIDE = prev;
  }
}

afterEach(() => {
  delete process.env.OMP_MEMORY_MODE;
});

describe("omp config", () => {
  it("get reports the defaults", async () => {
    const res = await runCli(["config", "get", "--root", root()]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("memory-mode=off");
    expect(res.message).toContain("memory-review-model=gpt-5-mini");
  });

  it("set memory-mode on then get reflects it", async () => {
    // --no-validate avoids spawning a real copilot probe; memory-mode writes the
    // GLOBAL ~/.omp config, so isolate the home to avoid cross-test leakage.
    await withHome(async () => {
      const cwd = root();
      await runCli(["config", "set", "memory-mode", "on", "--no-validate", "--root", cwd]);
      const res = await runCli(["config", "get", "--root", cwd]);
      expect(res.message).toContain("memory-mode=on");
    });
  });

  it("global memory-mode off is authoritative over a stale project key", async () => {
    await withHome(async () => {
      const { setMemoryConfigValue } = await import("../../src/memory-review/config.js");
      const cwd = root();
      setMemoryConfigValue(cwd, "memoryMode", "on", { scope: "project" }); // stale project on
      await runCli(["config", "set", "memory-mode", "off", "--root", cwd]);
      const res = await runCli(["config", "get", "--root", cwd]);
      expect(res.message).toContain("memory-mode=off");
    });
  });

  it("set memory-review-model persists", async () => {
    const cwd = root();
    await runCli(["config", "set", "memory-review-model", "haiku-x", "--root", cwd]);
    const res = await runCli(["config", "get", "--root", cwd]);
    expect(res.message).toContain("memory-review-model=haiku-x");
  });

  it("rejects an invalid memory-mode value", async () => {
    const res = await runCli(["config", "set", "memory-mode", "maybe", "--root", root()]);
    expect(res.ok).toBe(false);
  });

  it("set --global writes to ~/.omp, not the project, and config get reads it", async () => {
    const home = root();
    const cwd = root();
    const prev = process.env.OMP_HOME_OVERRIDE; // preserve setup.ts isolation
    process.env.OMP_HOME_OVERRIDE = home; // test seam honored by the cli
    try {
      const set = await runCli(["config", "set", "memory-review-model", "global-model", "--global", "--root", cwd]);
      expect(set.ok).toBe(true);
      expect(existsSync(path.join(home, ".omp", "config.json"))).toBe(true);
      expect(existsSync(path.join(cwd, ".omp", "config.json"))).toBe(false); // project untouched
      const get = await runCli(["config", "get", "--root", cwd]);
      expect(get.message).toContain("memory-review-model=global-model");
    } finally {
      process.env.OMP_HOME_OVERRIDE = prev; // restore, don't wipe isolation
    }
  });

  it("sets and reports memory-review-min-messages", async () => {
    const cwd = root();
    await runCli(["config", "set", "memory-review-min-messages", "6", "--root", cwd]);
    const res = await runCli(["config", "get", "--root", cwd]);
    expect(res.message).toContain("memory-review-min-messages=6");
  });

  it("rejects a non-numeric min-messages value", async () => {
    const res = await runCli(["config", "set", "memory-review-min-messages", "lots", "--root", root()]);
    expect(res.ok).toBe(false);
  });
});

describe("omp memory-review", () => {
  it("skips (no copilot spawn) when memory-mode is off", async () => {
    const res = await runCli(["memory-review", "--session", "deadbeef-1111", "--root", root()]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("memory-mode off");
  });

  it("rejects a path-traversal session id", async () => {
    await withHome(async () => {
      const cwd = root();
      await runCli(["config", "set", "memory-mode", "on", "--no-validate", "--root", cwd]);
      const res = await runCli(["memory-review", "--session", "../../etc", "--root", cwd]);
      expect(res.ok).toBe(false);
      expect(res.message).toContain("invalid --session id");
    });
  });
});

describe("omp project-memory prune-notes", () => {
  it("prunes to --keep N and reports removed count", async () => {
    const cwd = root();
    await runCli(["project-memory", "add-note", "A", "--root", cwd]);
    await runCli(["project-memory", "add-note", "B", "--root", cwd]);
    await runCli(["project-memory", "add-note", "C", "--root", cwd]);
    const res = await runCli(["project-memory", "prune-notes", "--keep", "1", "--root", cwd]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("2"); // removed 2
    const idx = await runCli(["project-memory", "index", "--root", cwd]);
    expect((idx.output as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it("errors without --keep or --older-than (no silent delete)", async () => {
    const res = await runCli(["project-memory", "prune-notes", "--root", root()]);
    expect(res.ok).toBe(false);
  });
});
