#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { checkForUpdate, formatUpdateNotice } from "./lib/version-check.mjs";
import { scanScheduleResults } from "./lib/schedule-results.mjs";

const HOOK_NAME = "SessionStart";

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.directory ?? process.cwd();
    const stateDir = join(directory, ".omp", "state");
    const logFile = join(stateDir, "hooks.log");
    mkdirSync(dirname(logFile), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      hook: HOOK_NAME,
      sessionId,
      directory,
    });
    appendFileSync(logFile, `${line}\n`);

    const update = await checkForUpdate({ stateDir });
    const parts = [];
    if (update) parts.push(formatUpdateNotice(update.current, update.latest));
    try {
      const scheduleBanner = scanScheduleResults(directory);
      if (scheduleBanner) parts.push(scheduleBanner);
    } catch (e) {
      // schedule scan is best-effort; never block session start
      console.error(`[hook ${HOOK_NAME}] schedule scan failed: ${e?.message ?? e}`);
    }
    const additionalContext = parts.join("\n\n");

    console.log(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: { hookEventName: HOOK_NAME, additionalContext },
      }),
    );
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    console.log(JSON.stringify({ continue: true }));
  }
})();
