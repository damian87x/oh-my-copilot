#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { endSession } from "./lib/daily-log.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { failOpen } from "./lib/hook-output.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";

const HOOK_NAME = "SessionEnd";

(async () => {
  try {
    const raw = await readStdin();
    const input = parseHookInput(raw);
    const sessionId = input.sessionId;
    const directory = input.cwd;
    const logFile = join(ompRoot(directory), ".omp", "state", "hooks.log");
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK_NAME, sessionId, directory })}\n`,
      );
    } catch {
      // best effort
    }
    // Arm a daily-log nudge for the next session if this one did work but
    // logged nothing. endSession never throws.
    endSession(directory);
    failOpen();
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
