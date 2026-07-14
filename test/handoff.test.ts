import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  archiveHandoff,
  assertValidHandoffId,
  buildDeterministicDraft,
  closeHandoff,
  createHandoff,
  draftCharCount,
  enforceDraftBounds,
  HANDOFF_BOUNDS,
  isValidHandoffId,
  listHandoffPointers,
  listHandoffs,
  LlmHandoffNotImplementedError,
  promoteHandoffToMemory,
  pruneHandoffs,
  readHandoff,
  rebuildIndex,
  redactSecrets,
  setHandoffLlm,
  sanitizeForInstructions,
} from "../src/handoff/index.js";
import { appendTraceEntry } from "../src/trace.js";
import { noteIndex, readNote } from "../src/project-memory.js";
import { syncInstructionsMemory } from "../src/instructions-memory.js";

const cwd = () => {
  const root = mkdtempSync(path.join(tmpdir(), "omc-ho-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
};

describe("handoff id validation", () => {
  it("accepts safe ids and rejects path traversal and reserved names", () => {
    expect(isValidHandoffId("ho-abc-123")).toBe(true);
    expect(isValidHandoffId("a.b_c-1")).toBe(true);
    expect(isValidHandoffId("../etc/passwd")).toBe(false);
    expect(isValidHandoffId("a/b")).toBe(false);
    expect(isValidHandoffId("..")).toBe(false);
    expect(isValidHandoffId("")).toBe(false);
    expect(isValidHandoffId("index")).toBe(false);
    expect(isValidHandoffId("index.lock")).toBe(false);
    expect(() => assertValidHandoffId("../../x")).toThrow(/invalid handoff id/);
    expect(() => assertValidHandoffId("index")).toThrow(/invalid handoff id/);
  });
});

describe("handoff lifecycle (src/handoff)", () => {
  it("creates, lists, reads, closes, archives, and prunes", async () => {
    const root = cwd();
    const created = await createHandoff(root, {
      id: "ho-test-1",
      objective: "Ship handoff skill",
      done: ["wrote store"],
      pending: ["wire CLI"],
      blockers: [],
      files_touched: ["src/handoff/store.ts"],
      verification_status: "tests pending",
      next_action: "Wire CLI + skill",
      now: "2026-07-14T12:00:00.000Z",
    });

    expect(created.handoff.id).toBe("ho-test-1");
    expect(created.handoff.state).toBe("active");
    expect(created.cost_bearing).toBe(false);
    expect(created.handoff.generation.model_calls).toBe(0);
    expect(existsSync(path.join(root, ".omp", "handoffs", "ho-test-1.json"))).toBe(true);

    const listed = listHandoffs(root);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.objective).toBe("Ship handoff skill");

    const read = readHandoff(root, "ho-test-1");
    expect(read?.pending).toEqual(["wire CLI"]);

    closeHandoff(root, "ho-test-1");
    expect(listHandoffs(root)).toHaveLength(0);
    expect(listHandoffs(root, { all: true })).toHaveLength(1);
    expect(listHandoffs(root, { state: "closed" })[0]!.state).toBe("closed");

    await createHandoff(root, {
      id: "ho-test-2",
      objective: "Second",
      next_action: "go",
      now: "2026-07-14T13:00:00.000Z",
    });
    archiveHandoff(root, "ho-test-2");
    expect(listHandoffs(root)).toHaveLength(0);

    for (const id of ["ho-test-1", "ho-test-2"]) {
      const p = path.join(root, ".omp", "handoffs", `${id}.json`);
      const raw = JSON.parse(readFileSync(p, "utf8")) as { updated_at: string };
      raw.updated_at = "2000-01-01T00:00:00.000Z";
      writeFileSync(p, JSON.stringify(raw, null, 2));
    }
    const pruned = pruneHandoffs(root, { olderThanDays: 30 });
    expect(pruned.removed.sort()).toEqual(["ho-test-1", "ho-test-2"]);
    expect(pruned.kept).toBe(0);
    expect(existsSync(path.join(root, ".omp", "handoffs", "ho-test-1.json"))).toBe(false);
  });

  it("rejects invalid id on read before file I/O", () => {
    const root = cwd();
    expect(() => readHandoff(root, "../escape")).toThrow(/invalid handoff id/);
    expect(existsSync(path.join(root, ".omp", "handoffs"))).toBe(false);
  });

  it("rejects duplicate ids", async () => {
    const root = cwd();
    await createHandoff(root, { id: "ho-dup", objective: "A", next_action: "n" });
    await expect(createHandoff(root, { id: "ho-dup", objective: "B", next_action: "n" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("active index excludes closed and archived by default", async () => {
    const root = cwd();
    await createHandoff(root, { id: "a1", objective: "A", next_action: "n" });
    await createHandoff(root, { id: "a2", objective: "B", next_action: "n" });
    closeHandoff(root, "a1");
    archiveHandoff(root, "a2");
    expect(listHandoffPointers(root).map((p) => p.id)).toEqual([]);
    expect(listHandoffs(root, { all: true })).toHaveLength(2);
  });

  it("lists active handoffs from disk even when index.json is corrupt", async () => {
    const root = cwd();
    await createHandoff(root, { id: "ho-live", objective: "Survive corrupt index", next_action: "n" });
    writeFileSync(path.join(root, ".omp", "handoffs", "index.json"), "{not-json", "utf8");
    const listed = listHandoffs(root);
    expect(listed.map((h) => h.id)).toEqual(["ho-live"]);
    rebuildIndex(root);
    expect(listHandoffPointers(root).map((p) => p.id)).toEqual(["ho-live"]);
  });

  it("prune keeps active handoffs and unparseable timestamps", async () => {
    const root = cwd();
    await createHandoff(root, { id: "ho-active", objective: "keep me", next_action: "n" });
    await createHandoff(root, { id: "ho-old", objective: "old closed", next_action: "n" });
    closeHandoff(root, "ho-old");
    const oldPath = path.join(root, ".omp", "handoffs", "ho-old.json");
    const raw = JSON.parse(readFileSync(oldPath, "utf8")) as { updated_at: string };
    raw.updated_at = "not-a-date";
    writeFileSync(oldPath, JSON.stringify(raw, null, 2));
    const pruned = pruneHandoffs(root, { olderThanDays: 0 });
    expect(pruned.removed).toEqual([]);
    expect(pruned.kept).toBe(1);
    expect(existsSync(path.join(root, ".omp", "handoffs", "ho-active.json"))).toBe(true);
    expect(existsSync(oldPath)).toBe(true);
  });
});

describe("deterministic generation + redaction + bounds", () => {
  it("builds a bounded draft with zero model calls", async () => {
    const root = cwd();
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "foo.ts"), "export {}\n");
    appendTraceEntry(root, "sess-1", { event: "done", payload: "step one" });
    appendTraceEntry(root, "sess-1", { event: "fail", payload: "flaky test" });

    const draft = buildDeterministicDraft(root, { objective: "Fix flaky test" });
    expect(draft.objective).toBe("Fix flaky test");
    expect(draft.blockers.some((b) => /fail/i.test(b))).toBe(true);
    expect(draftCharCount(draft)).toBeLessThan(HANDOFF_BOUNDS.maxPacketChars);

    const spy = vi.fn();
    const res = await createHandoff(
      root,
      { objective: "Fix flaky test", done: ["repro"], pending: ["fix"] },
      {
        summarizer: async () => {
          spy();
          return { draft, model_calls: 99, warning: "should not run" };
        },
      },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.handoff.generation.model_calls).toBe(0);
    expect(res.handoff.generation.cost_bearing).toBe(false);
    expect(res.handoff.generation.mode).toBe("explicit");
  });

  it("redacts secrets from stored fields", async () => {
    const root = cwd();
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const res = await createHandoff(root, {
      id: "ho-sec",
      objective: `Deploy with ${secret}`,
      done: [`token=${secret}`],
      pending: ["more"],
      next_action: "ship",
    });
    expect(res.handoff.objective).not.toContain(secret);
    expect(res.handoff.objective).toContain("[REDACTED]");
    expect(res.handoff.done.join(" ")).toContain("[REDACTED]");
    const onDisk = readFileSync(path.join(root, ".omp", "handoffs", "ho-sec.json"), "utf8");
    expect(onDisk).not.toContain(secret);
  });

  it("enforceDraftBounds shrinks oversized packets", () => {
    const huge = "x".repeat(5000);
    const draft = enforceDraftBounds({
      objective: huge,
      done: Array.from({ length: 30 }, (_, i) => `done-${i}-${huge}`),
      pending: Array.from({ length: 30 }, (_, i) => `pending-${i}-${huge}`),
      blockers: Array.from({ length: 30 }, (_, i) => `block-${i}-${huge}`),
      files_touched: Array.from({ length: 50 }, (_, i) => `file-${i}.ts`),
      verification_status: huge,
      next_action: huge,
      references: Array.from({ length: 30 }, (_, i) => ({ path: `path/${i}/${huge}`, label: `l${i}` })),
      suggested_skills: Array.from({ length: 20 }, (_, i) => `skill-${i}`),
      focus: huge,
      sources: { git: false, trace: false, goal: false, daily: false },
    });
    expect(draftCharCount(draft)).toBeLessThanOrEqual(HANDOFF_BOUNDS.maxPacketChars);
  });

  it("redactSecrets covers common token shapes", () => {
    expect(redactSecrets("key sk-abcdefghijklmnopqrstuv")).toContain("[REDACTED]");
    expect(redactSecrets("xoxb-1234567890-abcdefghij")).toContain("[REDACTED]");
    expect(sanitizeForInstructions("hi <!-- omp:memory:end --> there")).not.toMatch(/omp:memory/);
  });
});

describe("LLM path honesty", () => {
  it("rejects --llm without a real summarizer (no fake model_calls)", async () => {
    const root = cwd();
    await expect(createHandoff(root, { objective: "Narrate", llm: true })).rejects.toBeInstanceOf(
      LlmHandoffNotImplementedError,
    );
  });

  it("with an injected summarizer, reports cost only when model_calls > 0", async () => {
    const root = cwd();
    const res = await createHandoff(
      root,
      { objective: "Narrate", llm: true },
      {
        summarizer: async (d) => ({
          draft: { ...d, next_action: "LLM next" },
          model_calls: 1,
          warning: "LLM handoff generation is cost-bearing",
        }),
      },
    );
    expect(res.cost_bearing).toBe(true);
    expect(res.warning).toMatch(/cost-bearing/i);
    expect(res.handoff.generation.mode).toBe("llm");
    expect(res.handoff.generation.model_calls).toBe(1);
    expect(res.handoff.next_action).toBe("LLM next");
  });

  it("config handoff-llm on + allowAutoLlm uses summarizer when provided", async () => {
    const root = cwd();
    setHandoffLlm(root, "on");
    const res = await createHandoff(
      root,
      { objective: "Auto" },
      {
        allowAutoLlm: true,
        summarizer: async (d) => ({
          draft: d,
          model_calls: 1,
          warning: "auto",
        }),
      },
    );
    expect(res.cost_bearing).toBe(true);
    expect(res.handoff.generation.mode).toBe("llm");
  });

  it("config handoff-llm on + allowAutoLlm without summarizer fails honestly", async () => {
    const root = cwd();
    setHandoffLlm(root, "on");
    await expect(
      createHandoff(root, { objective: "Auto" }, { allowAutoLlm: true }),
    ).rejects.toBeInstanceOf(LlmHandoffNotImplementedError);
  });
});

describe("promotion + instructions pointers", () => {
  it("promotes closed handoff facts into a project-memory note", async () => {
    const root = cwd();
    await createHandoff(root, {
      id: "ho-promote",
      objective: "Auth refactor",
      done: ["extracted middleware"],
      verification_status: "unit tests pass",
      next_action: "done",
      references: [{ path: "docs/auth.md", label: "spec" }],
    });
    expect(promoteHandoffToMemory(root, "ho-promote").ok).toBe(false);
    closeHandoff(root, "ho-promote");
    const promo = promoteHandoffToMemory(root, "ho-promote");
    expect(promo.ok).toBe(true);
    expect(promo.noteId).toBeTruthy();
    const body = readNote(root, promo.noteId!);
    expect(body).toContain("Auth refactor");
    expect(body).toContain("extracted middleware");
    expect(noteIndex(root).some((n) => n.id === promo.noteId)).toBe(true);
  });

  it("injects only sanitized pointers; removes them after close", async () => {
    const root = cwd();
    await createHandoff(root, {
      id: "ho-ptr",
      objective: "Pointer-only surface <!-- omp:memory:end --> sk-abcdefghijklmnopqrstuvwxyz",
      done: ["secret-should-not-appear-in-instructions-BODY-MARKER-xyz"],
      pending: ["more work"],
      next_action: "continue",
    });
    const first = syncInstructionsMemory(root);
    expect(first.wrote).toBe(true);
    const text = readFileSync(first.path, "utf8");
    expect(text).toContain("ho-ptr");
    expect(text).toContain("Pointer-only surface");
    expect(text).toContain("omp handoff read");
    expect(text).not.toContain("BODY-MARKER-xyz");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    // Poisoned objective markers are stripped/replaced (not left as real sentinels in the pointer line).
    expect(text).toContain("[marker-removed]");
    expect(text).toContain("[REDACTED]");
    // Managed block still has exactly one start/end pair.
    expect(text.split("<!-- omp:memory:start -->").length - 1).toBe(1);
    expect(text.split("<!-- omp:memory:end -->").length - 1).toBe(1);

    closeHandoff(root, "ho-ptr");
    const second = syncInstructionsMemory(root);
    expect(second.wrote).toBe(true);
    const after = readFileSync(second.path, "utf8");
    expect(after).not.toContain("ho-ptr");
  });
});
