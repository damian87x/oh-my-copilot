#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { endSession } from "./lib/daily-log.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { failOpen } from "./lib/hook-output.mjs";

const HOOK_NAME = "SessionEnd";

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.cwd ?? data.directory ?? process.cwd();
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
