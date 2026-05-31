#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { checkForUpdate, formatUpdateNotice } from "./lib/version-check.mjs";
import { readRepoGoal, readTodayGoal, recentEntryStats, startSession } from "./lib/daily-log.mjs";
import { readDirectives } from "./lib/project-memory.mjs";

const HOOK_NAME = "SessionStart";

function buildDailyLogBreadcrumb(directory) {
  try {
    const goal = readTodayGoal(directory);
    const { entries } = recentEntryStats(directory, 7);
    if (!goal && entries === 0) return "";
    const lines = ["[DAILY LOG]"];
    if (goal) lines.push(`Goal: ${goal}`);
    if (entries > 0)
      lines.push(
        `${entries} ${entries === 1 ? "entry" : "entries"} logged in the last 7 days — run \`omp daily-log read\` to load if relevant.`,
      );
    return lines.join("\n");
  } catch {
    return "";
  }
}

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

    const parts = [];
    const update = await checkForUpdate({ stateDir });
    if (update) parts.push(formatUpdateNotice(update.current, update.latest));
    // Directives are must-follow rules — injected unconditionally (never on-demand)
    // so the agent can't skip a rule by judging it "unrelated".
    const directives = readDirectives(directory);
    if (directives.length > 0) {
      parts.push(`[DIRECTIVES] Follow these this session:\n${directives.map((d) => `- ${d}`).join("\n")}`);
    }
    const repoGoal = readRepoGoal(directory);
    if (repoGoal) parts.push(`[REPO GOAL] ${repoGoal}`);
    const breadcrumb = buildDailyLogBreadcrumb(directory);
    if (breadcrumb) parts.push(breadcrumb);
    // Resets the per-session baseline and flushes a nudge when the prior session
    // did work but logged nothing. startSession never throws.
    const flush = startSession(directory);
    if (flush) parts.push(`[DAILY LOG] ${flush}`);
    const additionalContext = parts.join("\n\n---\n\n");

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
