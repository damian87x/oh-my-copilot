import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCostRecord, costLedgerPath, readCostRecords } from "../../src/cost/ledger.js";

describe("cost ledger", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-cost-ledger-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends JSONL records under .omp/state/cost by sanitized session id", () => {
    const file = appendCostRecord(root, {
      sessionId: "session/with space",
      event: "postToolUse",
      toolName: "bash",
      inTokens: 3,
      outTokens: 5,
      note: "smoke",
    });

    expect(file).toBe(costLedgerPath(root, "session/with space"));
    expect(file).toMatch(/\.omp\/state\/cost\/session-with-space\.jsonl$/);
    const raw = readFileSync(file, "utf8").trim();
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      sessionId: "session/with space",
      event: "postToolUse",
      toolName: "bash",
      inTokens: 3,
      outTokens: 5,
      note: "smoke",
    });
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads records across all session ledgers", () => {
    mkdirSync(join(root, "nested"));
    appendCostRecord(join(root, "nested"), { sessionId: "s1", event: "userPromptSubmitted", inTokens: 2 });
    appendCostRecord(root, { sessionId: "s2", event: "postToolUse", outTokens: 7 });

    expect(readCostRecords(root).map((r) => [r.sessionId, r.event, r.inTokens ?? 0, r.outTokens ?? 0])).toEqual([
      ["s1", "userPromptSubmitted", 2, 0],
      ["s2", "postToolUse", 0, 7],
    ]);
    expect(readCostRecords(root, { sessionId: "s2" }).map((r) => r.sessionId)).toEqual(["s2"]);
  });
});
