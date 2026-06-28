import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendMailbox,
  listMailbox,
  markDelivered,
  peekMailbox,
  readNewMailbox,
  validateRecipientName,
} from "../../src/team/mailbox.js";
import type { MailboxMessage } from "../../src/team/types.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "omp-mailbox-"));
}

function msg(to: string, extra: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    type: "message",
    id: extra.id ?? `id-${Math.random().toString(36).slice(2)}`,
    from: "worker-1",
    to,
    body: "hello",
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe("validateRecipientName", () => {
  it("rejects path-traversal names and accepts safe names", () => {
    for (const bad of ["../escape", "worker-1/../../etc", ".", "..", "foo\\bar", ""]) {
      expect(validateRecipientName(bad)).toBe(false);
    }
    for (const good of ["worker-1", "leader", "worker-12"]) {
      expect(validateRecipientName(good)).toBe(true);
    }
  });
});

describe("mailbox", () => {
  it("returns empty when mailbox file is missing", () => {
    const dir = tempDir();
    expect(readNewMailbox(dir, "worker-2")).toEqual([]);
    expect(listMailbox(dir, "worker-2")).toEqual([]);
  });

  it("appendMailbox creates the recipient file with valid message JSONL", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    const raw = readFileSync(path.join(dir, "worker-2.jsonl"), "utf8").trim();
    const parsed = JSON.parse(raw) as MailboxMessage;
    expect(parsed.type).toBe("message");
    expect(parsed.id).toBe("a");
  });

  it("readNewMailbox returns only new messages and advances the cursor", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    appendMailbox(dir, msg("worker-2", { id: "b" }));
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a", "b"]);
    expect(readNewMailbox(dir, "worker-2")).toEqual([]);
    appendMailbox(dir, msg("worker-2", { id: "c" }));
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["c"]);
  });

  it("readNewMailbox skips delivery-receipt lines but advances past them", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    markDelivered(dir, "worker-2", "a"); // appends a receipt line
    appendMailbox(dir, msg("worker-2", { id: "b" }));
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a", "b"]);
    // cursor consumed the receipt too — nothing new remains
    expect(readNewMailbox(dir, "worker-2")).toEqual([]);
  });

  it("peekMailbox does not advance the cursor", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    expect(peekMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a"]);
    expect(peekMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a"]);
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a"]);
  });

  it("listMailbox returns all messages with merged deliveredAt", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    appendMailbox(dir, msg("worker-2", { id: "b" }));
    markDelivered(dir, "worker-2", "a");
    const view = listMailbox(dir, "worker-2");
    expect(view.map((m) => m.id)).toEqual(["a", "b"]);
    expect(view.find((m) => m.id === "a")?.deliveredAt).toBeTruthy();
    expect(view.find((m) => m.id === "b")?.deliveredAt).toBeUndefined();
  });

  it("markDelivered appends a receipt line (append-only, file grows)", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    const before = statSync(path.join(dir, "worker-2.jsonl")).size;
    expect(markDelivered(dir, "worker-2", "a")).toBe(true);
    const after = statSync(path.join(dir, "worker-2.jsonl")).size;
    expect(after).toBeGreaterThan(before);
    const lines = readFileSync(path.join(dir, "worker-2.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as { type: string }).type).toBe("delivery-receipt");
  });

  it("markDelivered does NOT invalidate an active cursor", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "m1" }));
    appendMailbox(dir, msg("worker-2", { id: "m2" }));
    appendMailbox(dir, msg("worker-2", { id: "m3" }));
    // consume m1, m2 (cursor now past them)
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    markDelivered(dir, "worker-2", "m1"); // append receipt after the cursor
    appendMailbox(dir, msg("worker-2", { id: "m4" }));
    // only the receipt (filtered) + m4 are new — must return ONLY m4, no dupes/corruption
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["m4"]);
  });

  it("markDelivered returns false for unknown messageId and writes nothing", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    const before = statSync(path.join(dir, "worker-2.jsonl")).size;
    expect(markDelivered(dir, "worker-2", "nope")).toBe(false);
    expect(statSync(path.join(dir, "worker-2.jsonl")).size).toBe(before);
  });

  it("waits for a complete line before advancing", () => {
    const dir = tempDir();
    appendMailbox(dir, msg("worker-2", { id: "a" }));
    appendFileSync(path.join(dir, "worker-2.jsonl"), '{"partial":');
    expect(readNewMailbox(dir, "worker-2").map((m) => m.id)).toEqual(["a"]);
    appendFileSync(path.join(dir, "worker-2.jsonl"), ' "no"}\n');
    // partial line is not a message (no type:"message") so it is filtered, but cursor advances
    expect(readNewMailbox(dir, "worker-2")).toEqual([]);
  });

  it("throws when building a path for an invalid recipient name", () => {
    const dir = tempDir();
    expect(() => appendMailbox(dir, msg("../escape", { id: "x" }))).toThrow(/invalid_recipient_name/);
  });
});
