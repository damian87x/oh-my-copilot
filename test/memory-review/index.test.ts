import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMemoryReview } from "../../src/memory-review/index.js";
import { setMemoryConfigValue } from "../../src/memory-review/config.js";
import { noteIndex, readDirectives } from "../../src/project-memory.js";
import { costLedgerPath } from "../../src/cost/ledger.js";
import type { CouncilSpawn, SpawnRequest, SpawnResponse } from "../../src/council/types.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-run-"));

function fakeSpawn(stdout: string, capture?: (req: SpawnRequest) => void): CouncilSpawn {
  return async (req: SpawnRequest): Promise<SpawnResponse> => {
    capture?.(req);
    return { stdout, stderr: "", exitCode: 0, timedOut: false };
  };
}

const REVIEW_JSON = JSON.stringify({
  directives: ["User prefers concise replies"],
  notes: [{ title: "Test runner", body: "uses vitest" }],
  skill_drafts: [{ slug: "release-flow", reason: "ship steps", body: "# release" }],
});

// ≥4 messages so it clears the default min-messages threshold (Q5).
const messages = () => [
  { role: "user", text: "ship the cache" },
  { role: "assistant", text: "writing lru.py" },
  { role: "user", text: "now tests" },
  { role: "assistant", text: "added test_lru.py, 2 passed" },
];

afterEach(() => {
  delete process.env.OMP_MEMORY_MODE;
});

describe("runMemoryReview (integration)", () => {
  it("no-ops when memory-mode is off, never spawning", async () => {
    const cwd = root();
    let called = false;
    const res = await runMemoryReview({
      cwd,
      sessionId: "s1",
      spawn: (async () => { called = true; return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; }) as CouncilSpawn,
      readTranscript: messages,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("memory-mode off");
    expect(called).toBe(false);
    expect(noteIndex(cwd)).toEqual([]);
  });

  it("runs end-to-end: cheap model, notes + drafts + gated directives + cost", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    setMemoryConfigValue(cwd, "memoryReviewModel", "cheap-model-x");

    let usedModel = "";
    const res = await runMemoryReview({
      cwd,
      sessionId: "sess-42",
      spawn: fakeSpawn(REVIEW_JSON, (req) => { usedModel = req.model; }),
      readTranscript: messages,
    });

    expect(res.ran).toBe(true);
    expect(usedModel).toBe("cheap-model-x");
    expect(res.summary).toMatchObject({ notesAdded: 1, draftsWritten: ["release-flow"], directivesQueued: 1 });
    expect(noteIndex(cwd).map((n) => n.title)).toContain("Test runner");
    expect(readDirectives(cwd)).toEqual([]); // gated
    expect(existsSync(path.join(cwd, ".oh-my-copilot", "memory-review", "pending-directives.md"))).toBe(true);

    const ledger = readFileSync(costLedgerPath(cwd, "sess-42"), "utf8");
    expect(ledger).toContain("memory-review");
    expect(ledger).toContain("cheap-model-x");

    // Q1: the review refreshes the injected block so the new note surfaces next session
    const instr = readFileSync(path.join(cwd, ".github", "copilot-instructions.md"), "utf8");
    expect(instr).toContain("Test runner"); // the note title is now in the managed block
  });

  it("rejects an invalid session id", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    const res = await runMemoryReview({ cwd, sessionId: "../../etc", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("invalid session id");
  });

  it("skips trivial sessions below the min-messages threshold, without claiming or spawning", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    setMemoryConfigValue(cwd, "memoryReviewMinMessages", "4");
    let called = false;
    const trivial = [{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }];
    const res = await runMemoryReview({
      cwd,
      sessionId: "trivial-1",
      spawn: (async () => { called = true; return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; }) as CouncilSpawn,
      readTranscript: () => trivial,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("below min-messages threshold");
    expect(called).toBe(false);
    // not claimed → a later, larger session can still run
    const later = await runMemoryReview({ cwd, sessionId: "trivial-1", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(later.ran).toBe(true);
  });

  it("skips the model call for an empty transcript", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    let called = false;
    const res = await runMemoryReview({
      cwd,
      sessionId: "empty",
      spawn: (async () => { called = true; return { stdout: "", stderr: "", exitCode: 0, timedOut: false }; }) as CouncilSpawn,
      readTranscript: () => [],
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("empty transcript");
    expect(called).toBe(false);
  });

  it("writes nothing when model output is unparseable", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    const res = await runMemoryReview({ cwd, sessionId: "bad", spawn: fakeSpawn("rambling, no json"), readTranscript: messages });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("unparseable review output");
    expect(noteIndex(cwd)).toEqual([]);
  });

  it("releases the claim on model failure so the session can be retried", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    const failing: CouncilSpawn = async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false });
    const first = await runMemoryReview({ cwd, sessionId: "retry-me", spawn: failing, readTranscript: messages });
    expect(first.ran).toBe(false);
    // a later retry must NOT be blocked by a stale claim, since nothing was written
    const second = await runMemoryReview({ cwd, sessionId: "retry-me", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(second.ran).toBe(true);
    expect(noteIndex(cwd)).toHaveLength(1);
  });

  it("surfaces an actionable error when the review model is unavailable", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    setMemoryConfigValue(cwd, "memoryReviewModel", "bad-model");
    const unavailable: CouncilSpawn = async () => ({
      stdout: "",
      stderr: 'Error: Model "bad-model" from --model flag is not available.',
      exitCode: 1,
      timedOut: false,
    });
    const res = await runMemoryReview({ cwd, sessionId: "unavail", spawn: unavailable, readTranscript: messages });
    expect(res.ran).toBe(false);
    expect(res.reason).toContain("bad-model");
    expect(res.reason).toContain("omp config set memory-review-model");
    expect(noteIndex(cwd)).toEqual([]);
    // claim released → retry with a good model succeeds
    const retry = await runMemoryReview({ cwd, sessionId: "unavail", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(retry.ran).toBe(true);
  });

  it("does not consume a claim for an empty transcript (retryable later)", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    const empty = await runMemoryReview({ cwd, sessionId: "grows", spawn: fakeSpawn(REVIEW_JSON), readTranscript: () => [] });
    expect(empty.ran).toBe(false);
    const later = await runMemoryReview({ cwd, sessionId: "grows", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(later.ran).toBe(true);
  });

  it("is idempotent per session — second run blocked by the claim", async () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "on");
    const first = await runMemoryReview({ cwd, sessionId: "dup", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    const second = await runMemoryReview({ cwd, sessionId: "dup", spawn: fakeSpawn(REVIEW_JSON), readTranscript: messages });
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already claimed");
    expect(noteIndex(cwd)).toHaveLength(1);
  });
});
