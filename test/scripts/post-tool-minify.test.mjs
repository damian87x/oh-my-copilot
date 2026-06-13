import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCostRecords } from "../../scripts/lib/cost-ledger.mjs";

function runPostTool(root, payload) {
  return JSON.parse(
    execFileSync(process.execPath, [join(process.cwd(), "scripts", "post-tool-use.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    }),
  );
}

describe("postToolUse output minimizer", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omp-post-tool-minify-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves small tool results unchanged while recording model-facing token cost", () => {
    const output = runPostTool(root, {
      sessionId: "s-small",
      cwd: root,
      toolName: "bash",
      toolArgs: { command: "printf ok" },
      toolResult: { resultType: "success", textResultForLlm: "ok\n" },
    });

    expect(output).toEqual({});
    expect(readCostRecords(root, { sessionId: "s-small" })).toMatchObject([
      { event: "postToolUse", toolName: "bash", outTokens: 1, rawOutTokens: 1, savedTokens: 0 },
    ]);
  });

  it("returns modifiedResult for noisy output, writes raw output, and records saved tokens", () => {
    const noisy = Array.from({ length: 260 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(60)}`).join("\n");

    const output = runPostTool(root, {
      sessionId: "s-big",
      cwd: root,
      toolName: "bash",
      toolArgs: { command: "npm test" },
      toolResult: { resultType: "success", textResultForLlm: noisy },
    });

    expect(output.modifiedResult.resultType).toBe("success");
    expect(output.modifiedResult.textResultForLlm).toContain("[omp] output trimmed");
    expect(output.modifiedResult.textResultForLlm.length).toBeLessThan(noisy.length);
    expect(output.additionalContext).toMatch(/output trimmed \d+→\d+ tokens/);

    const rows = readCostRecords(root, { sessionId: "s-big" });
    expect(rows).toHaveLength(1);
    expect(rows[0].rawOutTokens).toBeGreaterThan(rows[0].outTokens);
    expect(rows[0].savedTokens).toBe(rows[0].rawOutTokens - rows[0].outTokens);
    expect(rows[0].rawPath).toBeTruthy();
    expect(existsSync(rows[0].rawPath)).toBe(true);
    expect(readFileSync(rows[0].rawPath, "utf8")).toBe(noisy);
  });

  it("fails open without modifiedResult when raw output cannot be preserved", () => {
    const noisy = Array.from({ length: 260 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(60)}`).join("\n");

    const output = runPostTool("/dev/null", {
      sessionId: "s-raw-fail",
      cwd: "/dev/null",
      toolName: "bash",
      toolArgs: { command: "npm test" },
      toolResult: { resultType: "success", textResultForLlm: noisy },
    });

    expect(output).toEqual({});
  });

  it("does not minify large non-shell/read-style outputs", () => {
    const noisy = Array.from({ length: 260 }, (_, i) => `source line ${String(i).padStart(3, "0")} ${"x".repeat(60)}`).join("\n");

    const output = runPostTool(root, {
      sessionId: "s-read",
      cwd: root,
      toolName: "view",
      toolArgs: { path: "README.md" },
      toolResult: { resultType: "success", textResultForLlm: noisy },
    });

    expect(output).toEqual({});
    const rows = readCostRecords(root, { sessionId: "s-read" });
    expect(rows[0].rawOutTokens).toBe(rows[0].outTokens);
    expect(rows[0].savedTokens).toBe(0);
  });

});
