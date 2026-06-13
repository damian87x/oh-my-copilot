import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { appendCostRecord } from "../src/cost/ledger.js";

describe("runCli: cost", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-cli-cost-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prints a machine-readable token summary", async () => {
    appendCostRecord(root, { sessionId: "s1", event: "userPromptSubmitted", inTokens: 8 });
    appendCostRecord(root, { sessionId: "s1", event: "postToolUse", toolName: "bash", outTokens: 12 });

    const result = await runCli(["cost", "--root", root, "--session", "s1", "--json"]);

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      root,
      records: 2,
      sessions: ["s1"],
      totals: { inTokens: 8, outTokens: 12, totalTokens: 20 },
    });
  });

  it("prints a concise text summary", async () => {
    appendCostRecord(root, { sessionId: "s1", event: "postToolUse", toolName: "bash", outTokens: 12 });

    const result = await runCli(["cost", "--root", root]);

    expect(result.ok).toBe(true);
    expect(result.message ?? "").toContain("tokens: 12");
    expect(result.message ?? "").toContain("tool:bash");
  });
});
