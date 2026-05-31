#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { bumpPromptCount } from "./lib/daily-log.mjs";

const HOOK_NAME = "UserPromptSubmit";

function readModeState(directory, mode) {
  const p = join(directory, ".omp", "state", `${mode}.json`);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function buildContinuationContext(directory) {
  const ralph = readModeState(directory, "ralph");
  const ultrawork = readModeState(directory, "ultrawork");
  const ultraqa = readModeState(directory, "ultraqa");
  const parts = [];
  if (ralph?.active)
    parts.push(
      `[RALPH ACTIVE: iteration ${ralph.iteration}/${ralph.maxIterations}]\nPrompt: ${ralph.prompt}\nContinue the loop. Report concrete progress.`,
    );
  if (ultrawork?.active)
    parts.push(`[ULTRAWORK ACTIVE]\nObjective: ${ultrawork.objective}\nSustain the objective. Batch parallel tasks.`);
  if (ultraqa?.active)
    parts.push(
      `[ULTRAQA ACTIVE: cycle ${ultraqa.cycleCount}/${ultraqa.maxCycles}]\nGoal: ${ultraqa.goal}\nRun tests → verify → fix. Iterate.`,
    );
  return parts.join("\n\n---\n\n");
}

function buildDailyLogNudge(directory) {
  try {
    const { nudgeDue } = bumpPromptCount(directory);
    return nudgeDue
      ? "[DAILY LOG] You've made progress this session — consider daily_log_add to record what changed and any decisions, so the next session has context."
      : "";
  } catch {
    return "";
  }
}

function appendLog(directory, payload) {
  const logFile = join(directory, ".omp", "state", "hooks.log");
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ ts: new Date().toISOString(), hook: HOOK_NAME, ...payload })}\n`,
    );
  } catch {
    // best effort
  }
}

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const sessionId = data.sessionId ?? data.session_id ?? "unknown";
    const directory = data.directory ?? process.cwd();
    const prompt = data.prompt ?? data.message?.content ?? "";
    appendLog(directory, { sessionId, promptBytes: String(prompt).length });
    const parts = [];
    const cont = buildContinuationContext(directory);
    if (cont) parts.push(cont);
    const nudge = buildDailyLogNudge(directory);
    if (nudge) parts.push(nudge);
    const additionalContext = parts.join("\n\n---\n\n");
    const output = additionalContext
      ? { continue: true, hookSpecificOutput: { hookEventName: HOOK_NAME, additionalContext } }
      : { continue: true };
    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    console.log(JSON.stringify({ continue: true }));
  }
})();
