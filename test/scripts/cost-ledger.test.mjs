import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCostRecord, countTokens, readCostRecords } from "../../scripts/lib/cost-ledger.mjs";

describe("hook cost ledger helpers", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-script-cost-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("append/read mirrors the TypeScript ledger contract", () => {
    appendCostRecord(root, { sessionId: "s/1", event: "postToolUse", toolName: "bash", outTokens: countTokens("12345678") });
    expect(readCostRecords(root)).toMatchObject([{ sessionId: "s/1", event: "postToolUse", toolName: "bash", outTokens: 2 }]);
  });

  it("prompt and post-tool hooks write token records without changing hook output", () => {
    const promptOut = execFileSync(process.execPath, [join(process.cwd(), "scripts", "prompt-submit.mjs")], {
      input: JSON.stringify({ sessionId: "hook-s1", cwd: root, prompt: "hello from user" }),
      encoding: "utf8",
    });
    expect(JSON.parse(promptOut)).toEqual({});

    const postOut = execFileSync(process.execPath, [join(process.cwd(), "scripts", "post-tool-use.mjs")], {
      input: JSON.stringify({
        sessionId: "hook-s1",
        cwd: root,
        toolName: "bash",
        toolArgs: { command: "printf hello" },
        toolResult: { resultType: "success", textResultForLlm: "hello\n" },
      }),
      encoding: "utf8",
    });
    expect(JSON.parse(postOut)).toEqual({});

    const rows = readCostRecords(root).map((row) => ({
      event: row.event,
      toolName: row.toolName,
      inTokens: row.inTokens,
      outTokens: row.outTokens,
    }));
    expect(rows).toEqual([
      { event: "userPromptSubmitted", toolName: undefined, inTokens: 4, outTokens: 0 },
      { event: "postToolUse", toolName: "bash", inTokens: 7, outTokens: 2 },
    ]);

    const ledger = readFileSync(join(root, ".omp", "state", "cost", "hook-s1.jsonl"), "utf8");
    expect(ledger).toContain('"event":"postToolUse"');
  });
});
