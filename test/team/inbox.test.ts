import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendInbox, readInbox, writeInbox } from "../../src/team/inbox.js";

describe("inbox", () => {
  it("writes, reads, and appends inbox content", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "omc-inbox-")), "inbox.md");
    expect(readInbox(file)).toBe("");
    writeInbox(file, "## hello\n");
    expect(readInbox(file)).toBe("## hello\n");
    appendInbox(file, "more\n");
    expect(readInbox(file)).toBe("## hello\nmore\n");
  });
});
