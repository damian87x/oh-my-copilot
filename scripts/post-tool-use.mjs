#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { buildModifiedResultOutput, failOpen } from "./lib/hook-output.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";
import { appendCostRecord, countTokens } from "./lib/cost-ledger.mjs";
import { minifyToolOutput } from "./lib/minify.mjs";

const HOOK_NAME = "PostToolUse";

function safePathPart(value) {
  return (
    String(value || "unknown")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
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
    const minified = process.env.OMP_MINIFY === "0" ? {
      changed: false,
      text: rawText,
      rawTokens: countTokens(rawText),
      modelTokens: countTokens(rawText),
      savedTokens: 0,
    } : minifyToolOutput(rawText);
    let rawPath;
    const logFile = join(directory, ".omp", "state", "hooks.log");
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
      appendCostRecord(directory, {
        sessionId,
        event: "postToolUse",
        toolName,
        inTokens: countTokens(input.toolArgs),
        outTokens: minified.modelTokens,
        rawOutTokens: minified.rawTokens,
        savedTokens: minified.savedTokens,
        rawPath,
      });
    } catch {
      // best effort
    }
    if (minified.changed) {
      console.log(JSON.stringify(buildModifiedResultOutput(
        minified.text,
        `[omp] output trimmed ${minified.rawTokens}→${minified.modelTokens} tokens; full output at ${rawPath ?? "(raw write failed)"}`,
      )));
      return;
    }
    failOpen();
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
