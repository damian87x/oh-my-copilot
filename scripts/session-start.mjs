#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { failOpen, printContinue } from "./lib/hook-output.mjs";
import { checkForUpdate, formatUpdateNotice } from "./lib/version-check.mjs";
import { scanScheduleResults } from "./lib/schedule-results.mjs";
import { readRepoGoal, readTodayGoal, recentEntryStats, startSession } from "./lib/daily-log.mjs";
import { readDirectives } from "./lib/project-memory.mjs";
import { pendingDirectivesNudge } from "./lib/pending-directives.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";

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
        `${entries} ${entries === 1 ? "entry" : "entries"} logged in the last 7 days — run \`omp daily-log read --days 7\` to load if relevant.`,
      );
    return lines.join("\n");
  } catch {
    return "";
  }
}

(async () => {
  try {
    const raw = await readStdin();
    const input = parseHookInput(raw);
    const sessionId = input.sessionId;
    const directory = input.cwd;
    const stateDir = join(ompRoot(directory), ".omp", "state");
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
    try {
      const scheduleBanner = scanScheduleResults(ompRoot(directory));
      if (scheduleBanner) parts.push(scheduleBanner);
    } catch (e) {
      // schedule scan is best-effort; never block session start
      console.error(`[hook ${HOOK_NAME}] schedule scan failed: ${e?.message ?? e}`);
    }
    // Directives are must-follow rules — injected unconditionally (never on-demand)
    // so the agent can't skip a rule by judging it "unrelated". Capped by count +
    // chars so a bloated directive list can't balloon the start message; overflow
    // is summarized with a pointer (mirrors OpenClaw's injection budget).
    const directives = readDirectives(directory);
    if (directives.length > 0) {
      const MAX_DIRECTIVES = 12;
      const MAX_DIRECTIVE_CHARS = 1200;
      const shown = [];
      let chars = 0;
      for (const d of directives) {
        if (shown.length >= MAX_DIRECTIVES || chars + d.length > MAX_DIRECTIVE_CHARS) break;
        shown.push(d);
        chars += d.length;
      }
      const more = directives.length - shown.length;
      const body = shown.map((d) => `- ${d}`).join("\n");
      const tail = more > 0 ? `\n- (+${more} more — run \`omp project-memory read\` to see all)` : "";
      parts.push(`[DIRECTIVES] Follow these this session:\n${body}${tail}`);
    }
    const repoGoal = readRepoGoal(directory);
    if (repoGoal) parts.push(`[REPO GOAL] ${repoGoal}`);
    // Memory-review's gated directive queue is invisible without a nudge.
    const pendingNudge = pendingDirectivesNudge(directory);
    if (pendingNudge) parts.push(pendingNudge);
    const breadcrumb = buildDailyLogBreadcrumb(directory);
    if (breadcrumb) parts.push(breadcrumb);
    // Resets the per-session baseline and flushes a nudge when the prior session
    // did work but logged nothing. startSession never throws.
    const flush = startSession(directory);
    if (flush) parts.push(`[DAILY LOG] ${flush}`);
    const additionalContext = parts.join("\n\n---\n\n");

    printContinue(HOOK_NAME, additionalContext);
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
