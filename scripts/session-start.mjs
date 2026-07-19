#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { isMain } from "./lib/is-main.mjs";
import { buildContinueHookOutput, failOpen } from "./lib/hook-output.mjs";
import { checkForUpdate, formatUpdateNotice } from "./lib/version-check.mjs";
import { scanScheduleResults } from "./lib/schedule-results.mjs";
import { readRepoGoal, readTodayGoal, recentEntryStats, startSession } from "./lib/daily-log.mjs";
import { readDirectives } from "./lib/project-memory.mjs";
import { pendingDirectivesNudge } from "./lib/pending-directives.mjs";
import { readDirectiveCaps } from "./lib/memory-config.mjs";
import { notesSummary } from "./lib/notes-index.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";

const HOOK_NAME = "SessionStart";

function dirsBetweenCwdAndRoot(directory, root) {
  const dirs = [];
  let dir = resolve(directory);
  const stop = resolve(root);
  while (dir !== stop) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isNonEmptyDirectory(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export function nestedStateWarnings(directory, root) {
  const warnings = [];
  const rootState = join(root, ".omp", "state");
  for (const dir of dirsBetweenCwdAndRoot(directory, root)) {
    const stateDir = join(dir, ".omp", "state");
    if (existsSync(stateDir) && isDirectory(stateDir)) {
      warnings.push(
        `[OMP WARNING] Nested .omp/state found at ${stateDir}. ` +
          `This session uses ${rootState}; nested loop state is ignored. Remove it after confirming it is stale.`,
      );
    }

    const jobsDir = join(stateDir, "schedule", "jobs");
    if (isNonEmptyDirectory(jobsDir)) {
      warnings.push(
        `[OMP WARNING] Non-empty nested schedule jobs found at ${jobsDir}. ` +
          `Schedule management now uses ${join(rootState, "schedule", "jobs")}. ` +
          "Those nested jobs may still run if an OS scheduler entry pins their old root; review/remove them there and uninstall old scheduler entries if needed.",
      );
    }
  }
  return warnings;
}

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

export async function handleSessionStart(raw) {
  const input = parseHookInput(raw);
  const sessionId = input.sessionId;
  const directory = input.cwd;
  const root = ompRoot(directory);
  const stateDir = join(root, ".omp", "state");
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
  const warnings = nestedStateWarnings(directory, root);
  if (warnings.length > 0) parts.push(warnings.join("\n\n"));
  try {
    const scheduleBanner = scanScheduleResults(root);
    if (scheduleBanner) parts.push(scheduleBanner);
  } catch (e) {
    // schedule scan is best-effort; never block session start
    console.error(`[hook ${HOOK_NAME}] schedule scan failed: ${e?.message ?? e}`);
  }
  // Directives are must-follow rules — injected unconditionally (never on-demand)
  // so the agent can't skip a rule by judging it "unrelated". Capped by count +
  // chars (configurable: memory-directive-cap / memory-directive-char-cap) so a
  // bloated directive list can't balloon the start message; overflow is
  // summarized with a pointer (mirrors OpenClaw's injection budget).
  const directives = readDirectives(directory);
  if (directives.length > 0) {
    const { directiveCap, directiveCharCap } = readDirectiveCaps(directory);
    const shown = [];
    let chars = 0;
    for (const d of directives) {
      if (shown.length >= directiveCap) break;
      // char cap skips rather than stops: one oversized rule must not suppress
      // every shorter rule after it.
      if (chars + d.length > directiveCharCap) continue;
      shown.push(d);
      chars += d.length;
    }
    const more = directives.length - shown.length;
    const body = shown.map((d) => `- ${d}`).join("\n");
    const tail = more > 0 ? `\n- (+${more} more — run \`omp project-memory read\` to see all)` : "";
    parts.push(`[DIRECTIVES] Follow these this session:\n${body}${tail}`);
  }
  // Notes stay on-demand (progressive disclosure), but surface their existence
  // + newest titles so memory is discoverable even when the managed
  // copilot-instructions block is stale or missing. Bounded: ≤3 short titles.
  const notes = notesSummary(directory);
  if (notes.total > 0) {
    const titles = notes.titles.map((t) => `"${t}"`).join(", ");
    parts.push(
      `[MEMORY] ${notes.total} note${notes.total === 1 ? "" : "s"} in project memory — newest: ${titles} — ` +
        "run `omp project-memory read` for the index, `omp project-memory read <id>` for a body.",
    );
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

  return buildContinueHookOutput(HOOK_NAME, additionalContext);
}

async function main() {
  try {
    const raw = await readStdin();
    console.log(JSON.stringify(await handleSessionStart(raw)));
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
}

if (isMain(import.meta.url)) {
  main();
}
