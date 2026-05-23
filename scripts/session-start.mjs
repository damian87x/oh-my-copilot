#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";

const HOOK_NAME = "SessionStart";

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.directory ?? process.cwd();
    const logFile = join(directory, ".omp", "state", "hooks.log");
    mkdirSync(dirname(logFile), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      hook: HOOK_NAME,
      sessionId,
      directory,
    });
    appendFileSync(logFile, `${line}\n`);
    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: { hookEventName: HOOK_NAME, additionalContext: "" },
      }),
    );
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
})();
