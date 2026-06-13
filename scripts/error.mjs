#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { failOpen } from "./lib/hook-output.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";

const HOOK_NAME = "Error";

(async () => {
  try {
    const raw = await readStdin();
    const input = parseHookInput(raw);
    const sessionId = input.sessionId;
    const directory = input.cwd;
    const toolName = input.toolName;
    const errorMessage = input.error ?? "unknown";
    const logFile = join(directory, ".omp", "state", "hooks.log");
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK_NAME, sessionId, toolName, errorMessage })}\n`,
      );
    } catch {
      // best effort
    }
    failOpen();
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
