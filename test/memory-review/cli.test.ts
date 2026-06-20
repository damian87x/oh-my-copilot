import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../../src/cli.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-cli-"));

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
    const cwd = root();
    await runCli(["config", "set", "memory-mode", "on", "--root", cwd]);
    const res = await runCli(["config", "get", "--root", cwd]);
    expect(res.message).toContain("memory-mode=on");
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
    const cwd = root();
    await runCli(["config", "set", "memory-mode", "on", "--root", cwd]);
    const res = await runCli(["memory-review", "--session", "../../etc", "--root", cwd]);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("invalid --session id");
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
