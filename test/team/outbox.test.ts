import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendOutbox, peekNewOutbox, readNewOutbox, resetOutboxCursor } from "../../src/team/outbox.js";
import type { OutboxMessage } from "../../src/team/types.js";

function tempFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), "omc-outbox-"));
  return { outbox: path.join(dir, "outbox.jsonl"), cursor: path.join(dir, ".outbox-offset") };
}

function msg(extra: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    type: "task_complete",
    taskId: "1",
    status: "completed",
    result: "ok",
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe("outbox", () => {
  it("returns empty when outbox file is missing", () => {
    const { outbox, cursor } = tempFiles();
    expect(readNewOutbox(outbox, cursor)).toEqual([]);
  });

  it("returns only new messages and advances the cursor", () => {
    const { outbox, cursor } = tempFiles();
    appendOutbox(outbox, msg({ taskId: "a" }));
    appendOutbox(outbox, msg({ taskId: "b" }));
    const first = readNewOutbox(outbox, cursor);
    expect(first.map((m) => m.taskId)).toEqual(["a", "b"]);
    const second = readNewOutbox(outbox, cursor);
    expect(second).toEqual([]);
    appendOutbox(outbox, msg({ taskId: "c" }));
    const third = readNewOutbox(outbox, cursor);
    expect(third.map((m) => m.taskId)).toEqual(["c"]);
  });

  it("waits for a complete line before advancing", () => {
    const { outbox, cursor } = tempFiles();
    // write a partial JSON line (no trailing newline)
    appendOutbox(outbox, msg({ taskId: "a" }));
    // Manually corrupt: append a partial JSON without newline
    require("node:fs").appendFileSync(outbox, '{"partial":');
    const first = readNewOutbox(outbox, cursor);
    expect(first.map((m) => m.taskId)).toEqual(["a"]);
    // Cursor should not have consumed the partial line, so when we complete it:
    require("node:fs").appendFileSync(outbox, ' "yes"}\n');
    const second = readNewOutbox(outbox, cursor);
    expect(second).toHaveLength(1);
  });

  it("resets the cursor", () => {
    const { outbox, cursor } = tempFiles();
    appendOutbox(outbox, msg({ taskId: "a" }));
    readNewOutbox(outbox, cursor);
    resetOutboxCursor(cursor);
    const again = readNewOutbox(outbox, cursor);
    expect(again).toHaveLength(1);
  });

  it("peekNewOutbox returns new messages WITHOUT advancing the cursor", () => {
    const { outbox, cursor } = tempFiles();
    appendOutbox(outbox, msg({ taskId: "a" }));
    appendOutbox(outbox, msg({ taskId: "b" }));
    expect(peekNewOutbox(outbox, cursor).map((m) => m.taskId)).toEqual(["a", "b"]);
    // Calling peek again should return the same messages — cursor unchanged.
    expect(peekNewOutbox(outbox, cursor).map((m) => m.taskId)).toEqual(["a", "b"]);
    // A subsequent consuming read still returns both messages.
    expect(readNewOutbox(outbox, cursor).map((m) => m.taskId)).toEqual(["a", "b"]);
  });
});
