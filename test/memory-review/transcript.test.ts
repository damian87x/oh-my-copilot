import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isValidSessionId,
  latestSessionId,
  listSessionIds,
  newestSessionSince,
  parseTranscript,
  readSessionTranscript,
} from "../../src/memory-review/transcript.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-tr-"));

describe("transcript parsing (real Copilot events.jsonl format)", () => {
  // Real Copilot events are {"type":"user.message","data":{"content":...}} etc.,
  // interleaved with many non-message event types. Fixtures mirror actual data
  // captured from ~/.copilot/session-state/<uuid>/events.jsonl.
  it("extracts user + assistant message content, skips system + non-message events + junk", () => {
    const raw = [
      JSON.stringify({ type: "session.start", data: { sessionId: "x", version: 1 } }),
      JSON.stringify({ type: "system.message", data: { role: "system", content: "You are the GitHub Copilot CLI ..." } }),
      JSON.stringify({ type: "user.message", data: { content: "fix the bug", transformedContent: "<dt/>fix the bug" } }),
      JSON.stringify({ type: "assistant.turn_start", data: { turnId: "0" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "on it", toolRequests: [{ name: "bash" }] } }),
      JSON.stringify({ type: "tool.execution_start", data: { name: "bash" } }),
      "this is not json — should be skipped",
      "{ partial json at tail boundary",
    ].join("\n");
    expect(parseTranscript(raw)).toEqual([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "on it\n(tools: bash)" },
    ]);
  });

  it("captures tool-only assistant turns (empty content) as substantive entries", () => {
    // Real agentic sessions: most assistant turns have empty content and act via
    // toolRequests. These MUST count (otherwise a working session looks 'too short').
    const raw = [
      JSON.stringify({ type: "user.message", data: { content: "build the cache" } }),
      JSON.stringify({ type: "assistant.message", data: { content: "", toolRequests: [{ name: "apply_patch", intentionSummary: "write lru.py" }] } }),
      JSON.stringify({ type: "assistant.message", data: { content: "", toolRequests: [{ name: "bash", arguments: { command: "pytest -q" } }] } }),
      JSON.stringify({ type: "assistant.message", data: { content: "done", toolRequests: [] } }),
    ].join("\n");
    const msgs = parseTranscript(raw);
    expect(msgs).toHaveLength(4); // user + 3 assistant — clears the min-messages threshold
    expect(msgs[1].text).toContain("apply_patch");
    expect(msgs[1].text).toContain("write lru.py");
    expect(msgs[2].text).toContain("pytest -q"); // command surfaced when no intent
    expect(msgs[3].text).toBe("done");
  });

  it("reads a real-shaped events.jsonl from a session-state fixture dir", () => {
    const base = root();
    const uuid = "11111111-2222-3333-4444-555555555555";
    mkdirSync(path.join(base, uuid), { recursive: true });
    writeFileSync(
      path.join(base, uuid, "events.jsonl"),
      JSON.stringify({ type: "user.message", data: { content: "hello" } }) + "\n",
      "utf8",
    );
    expect(readSessionTranscript(uuid, { sessionStateDir: base })).toEqual([{ role: "user", text: "hello" }]);
  });

  it("returns empty (never throws) for a missing session", () => {
    expect(readSessionTranscript("does-not-exist", { sessionStateDir: root() })).toEqual([]);
  });

  it("reads the full conversation of a long session, then windows to the most recent maxMessages", () => {
    const base = root();
    const uuid = "long-session";
    mkdirSync(path.join(base, uuid), { recursive: true });
    // 200 user turns interleaved with bulky tool-output events (which we drop).
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ type: "user.message", data: { content: `turn ${i}` } }));
      lines.push(JSON.stringify({ type: "tool.execution_complete", data: { output: "x".repeat(2000) } }));
    }
    writeFileSync(path.join(base, uuid, "events.jsonl"), lines.join("\n") + "\n", "utf8");

    // Default window keeps the most recent N (not a byte-tail sliver eaten by tool output).
    const windowed = readSessionTranscript(uuid, { sessionStateDir: base, maxMessages: 50 });
    expect(windowed).toHaveLength(50);
    expect(windowed[0].text).toBe("turn 150"); // last 50 of 200
    expect(windowed[49].text).toBe("turn 199");

    // The reader can see the whole conversation when the window is large.
    const all = readSessionTranscript(uuid, { sessionStateDir: base, maxMessages: 1000 });
    expect(all).toHaveLength(200);
    expect(all[0].text).toBe("turn 0"); // the real start is NOT lost
  });
});

describe("isValidSessionId (path-traversal guard)", () => {
  it("accepts uuid-like ids, rejects traversal/separators", () => {
    expect(isValidSessionId("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isValidSessionId("sess_42.1")).toBe(true);
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("..")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });

  it("readSessionTranscript refuses a traversal id even if a matching file exists", () => {
    const base = root();
    mkdirSync(path.join(base, "evil"), { recursive: true });
    writeFileSync(path.join(base, "evil", "events.jsonl"), JSON.stringify({ role: "user", content: "secret" }) + "\n", "utf8");
    expect(readSessionTranscript("../evil", { sessionStateDir: path.join(base, "session-state") })).toEqual([]);
  });
});

describe("latestSessionId", () => {
  it("returns the most recently modified session dir", () => {
    const base = root();
    mkdirSync(path.join(base, "older"), { recursive: true });
    mkdirSync(path.join(base, "newer"), { recursive: true });
    utimesSync(path.join(base, "older"), new Date(1000), new Date(1000));
    utimesSync(path.join(base, "newer"), new Date(5000), new Date(5000));
    expect(latestSessionId(base)).toBe("newer");
  });

  it("returns null when the base dir is absent", () => {
    expect(latestSessionId(path.join(root(), "nope"))).toBeNull();
  });
});

describe("newestSessionSince (identify the just-created session)", () => {
  it("returns the session dir that did NOT exist in the before-set", () => {
    const base = root();
    mkdirSync(path.join(base, "old-a"), { recursive: true });
    mkdirSync(path.join(base, "old-b"), { recursive: true });
    const before = listSessionIds(base); // ["old-a","old-b"]
    expect(before.sort()).toEqual(["old-a", "old-b"]);
    mkdirSync(path.join(base, "fresh-c"), { recursive: true });
    expect(newestSessionSince(before, base)).toBe("fresh-c");
  });

  it("returns null when no new session appeared (don't guess)", () => {
    const base = root();
    mkdirSync(path.join(base, "only"), { recursive: true });
    const before = listSessionIds(base);
    expect(newestSessionSince(before, base)).toBeNull();
  });
});
