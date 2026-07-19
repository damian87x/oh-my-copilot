import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("sets and reports memory render caps", async () => {
    const cwd = root();
    await runCli(["config", "set", "memory-note-cap", "5", "--root", cwd]);
    await runCli(["config", "set", "memory-note-char-cap", "500", "--root", cwd]);
    await runCli(["config", "set", "memory-topic-cap", "6", "--root", cwd]);
    await runCli(["config", "set", "memory-topic-char-cap", "600", "--root", cwd]);
    const res = await runCli(["config", "get", "--root", cwd]);
    expect(res.message).toContain("memory-note-cap=5");
    expect(res.message).toContain("memory-note-char-cap=500");
    expect(res.message).toContain("memory-topic-cap=6");
    expect(res.message).toContain("memory-topic-char-cap=600");
  });

  it("sets and reports directive injection caps and note auto-keep", async () => {
    const cwd = root();
    await runCli(["config", "set", "memory-directive-cap", "20", "--root", cwd]);
    await runCli(["config", "set", "memory-directive-char-cap", "3000", "--root", cwd]);
    await runCli(["config", "set", "memory-note-auto-keep", "50", "--root", cwd]);
    const res = await runCli(["config", "get", "--root", cwd]);
    expect(res.message).toContain("memory-directive-cap=20");
    expect(res.message).toContain("memory-directive-char-cap=3000");
    expect(res.message).toContain("memory-note-auto-keep=50");
  });

  it("rejects invalid directive cap / auto-keep values", async () => {
    const cwd = root();
    expect((await runCli(["config", "set", "memory-directive-cap", "0", "--root", cwd])).ok).toBe(false);
    expect((await runCli(["config", "set", "memory-note-auto-keep", "-1", "--root", cwd])).ok).toBe(false);
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

describe("omp project-memory topics", () => {
  it("adds, lists, and reads topics", async () => {
    const cwd = root();
    const topic = await runCli(["project-memory", "add-topic", "Auth", "--description", "Authentication strategy", "--root", cwd]);
    expect(topic.ok).toBe(true);
    expect(topic.message).toContain("auth");
    const fact = await runCli(["project-memory", "add-fact", "AUTH", "JWT tokens rotate", "--root", cwd]);
    expect(fact.ok).toBe(true);
    const topics = await runCli(["project-memory", "topics", "--root", cwd]);
    expect(topics.message).toContain("auth\tAuthentication strategy");
    const read = await runCli(["project-memory", "read-topic", "auth", "--root", cwd]);
    expect(read.message).toContain("JWT tokens rotate");
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

describe("omp project-memory add-directive over-cap warning", () => {
  it("warns when the stored list outgrows the injection cap", async () => {
    const cwd = root();
    await runCli(["config", "set", "memory-directive-cap", "1", "--root", cwd]);
    const first = await runCli(["project-memory", "add-directive", "rule one", "--root", cwd]);
    expect(first.ok).toBe(true);
    expect(first.message).not.toContain("WARNING");
    const second = await runCli(["project-memory", "add-directive", "rule two", "--root", cwd]);
    expect(second.ok).toBe(true);
    expect(second.message).toContain("WARNING");
    expect(second.message).toContain("memory-directive-cap");
  });
});

describe("omp project-memory pending / promote / dismiss", () => {
  function seedQueue(cwd: string): void {
    const dir = path.join(cwd, ".omp", "memory-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "pending-directives.md"),
      "# Pending directives (review before applying)\n- [ ] Use pnpm not npm\n- [ ] Prefer concise replies\n",
      "utf8",
    );
  }

  it("lists the queue with 1-based indexes", async () => {
    const cwd = root();
    seedQueue(cwd);
    const res = await runCli(["project-memory", "pending", "--root", cwd]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("1. Use pnpm not npm");
    expect(res.message).toContain("2. Prefer concise replies");
  });

  it("reports when the queue is empty", async () => {
    const res = await runCli(["project-memory", "pending", "--root", root()]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("no pending");
  });

  it("promote-directive adds the rule and dequeues it", async () => {
    const cwd = root();
    seedQueue(cwd);
    const res = await runCli(["project-memory", "promote-directive", "1", "--root", cwd]);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Use pnpm not npm");

    const read = await runCli(["project-memory", "read", "--root", cwd]);
    expect((read.output as { directives: string[] }).directives).toEqual(["Use pnpm not npm"]);

    const pending = await runCli(["project-memory", "pending", "--root", cwd]);
    expect(pending.message).toContain("1. Prefer concise replies");
    expect(pending.message).not.toContain("pnpm");
    // the queue file kept its header
    const queueText = readFileSync(path.join(cwd, ".omp", "memory-review", "pending-directives.md"), "utf8");
    expect(queueText).toContain("# Pending directives");
  });

  it("promote-directive --all applies every proposal", async () => {
    const cwd = root();
    seedQueue(cwd);
    const res = await runCli(["project-memory", "promote-directive", "--all", "--root", cwd]);
    expect(res.ok).toBe(true);
    const read = await runCli(["project-memory", "read", "--root", cwd]);
    expect((read.output as { directives: string[] }).directives).toEqual([
      "Use pnpm not npm",
      "Prefer concise replies",
    ]);
    const pending = await runCli(["project-memory", "pending", "--root", cwd]);
    expect(pending.message).toContain("no pending");
  });

  it("dismiss-directive drops without adding", async () => {
    const cwd = root();
    seedQueue(cwd);
    const res = await runCli(["project-memory", "dismiss-directive", "2", "--root", cwd]);
    expect(res.ok).toBe(true);
    const read = await runCli(["project-memory", "read", "--root", cwd]);
    expect((read.output as { directives: string[] }).directives).toEqual([]);
    const pending = await runCli(["project-memory", "pending", "--root", cwd]);
    expect(pending.message).toContain("1. Use pnpm not npm");
    expect(pending.message).not.toContain("concise");
  });

  it("rejects an out-of-range index", async () => {
    const cwd = root();
    seedQueue(cwd);
    const res = await runCli(["project-memory", "promote-directive", "9", "--root", cwd]);
    expect(res.ok).toBe(false);
  });
});
