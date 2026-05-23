#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";

const HOOK_NAME = "Error";

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.directory ?? process.cwd();
    const toolName = data.toolName ?? data.tool_name ?? "unknown";
    const errorMessage = data.error?.message ?? data.message ?? "unknown";
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
    console.log(JSON.stringify({ continue: true }));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
})();
