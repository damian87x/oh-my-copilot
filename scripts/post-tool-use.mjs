#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";

const HOOK_NAME = "PostToolUse";

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.cwd ?? data.directory ?? process.cwd();
    const toolName = data.toolName ?? data.tool_name ?? "unknown";
    const ok = data.toolOutput != null;
    const logFile = join(directory, ".omp", "state", "hooks.log");
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK_NAME, sessionId, toolName, ok })}\n`,
      );
    } catch {
      // best effort
    }
    console.log(JSON.stringify({ continue: true }));
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    console.log(JSON.stringify({ continue: true }));
  }
})();
