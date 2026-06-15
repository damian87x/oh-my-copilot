#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { buildModifiedResultOutput, failOpen } from "./lib/hook-output.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";
import { appendCostRecord, countTokens } from "./lib/cost-ledger.mjs";
import { minifyToolOutput } from "./lib/minify.mjs";

const HOOK_NAME = "PostToolUse";
const NOISY_COMMAND_RE = /\b(npm|pnpm|yarn|bun|vitest|jest|mocha|pytest|cargo|go|tsc|eslint|biome|ruff|mypy|make|gradle|mvn)\b/i;

function safePathPart(value) {
  return (
    String(value || "unknown")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function shouldMinify(input) {
  if (process.env.OMP_MINIFY === "0") return false;
  const toolName = String(input.toolName || "").toLowerCase();
  const command = String(input.toolArgs?.command ?? input.toolArgs?.cmd ?? "");
  return (toolName === "bash" || toolName === "shell" || toolName === "terminal") && NOISY_COMMAND_RE.test(command);
}

(async () => {
  try {
    const raw = await readStdin();
    const input = parseHookInput(raw);
    const sessionId = input.sessionId;
    const directory = input.cwd;
    const toolName = input.toolName;
    const ok = input.toolResult != null;
    const rawText = input.toolResult?.textResultForLlm ?? "";
    const minified = !shouldMinify(input) ? {
      changed: false,
      text: rawText,
      rawTokens: countTokens(rawText),
      modelTokens: countTokens(rawText),
      savedTokens: 0,
    } : minifyToolOutput(rawText);
    let rawPath;
    const logFile = join(directory, ".omp", "state", "hooks.log");
    let canModifyResult = minified.changed;
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK_NAME, sessionId, toolName, ok })}\n`,
      );
      if (minified.changed) {
        rawPath = join(
          directory,
          ".omp",
          "state",
          "cost",
          "raw",
          `${safePathPart(sessionId)}-${Date.now()}-${safePathPart(toolName)}.txt`,
        );
        mkdirSync(dirname(rawPath), { recursive: true });
        writeFileSync(rawPath, rawText, "utf8");
      }
    } catch {
      canModifyResult = false;
    }
    try {
      appendCostRecord(directory, {
        sessionId,
        event: "postToolUse",
        toolName,
        inTokens: countTokens(input.toolArgs),
        outTokens: canModifyResult ? minified.modelTokens : minified.rawTokens,
        rawOutTokens: minified.rawTokens,
        savedTokens: canModifyResult ? minified.savedTokens : 0,
        rawPath,
      });
    } catch {
      // best effort
    }
    if (canModifyResult) {
      console.log(JSON.stringify(buildModifiedResultOutput(
        minified.text,
        `[omp] output trimmed ${minified.rawTokens}→${minified.modelTokens} tokens; full output at ${rawPath}`,
      )));
      return;
    }
    failOpen();
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
