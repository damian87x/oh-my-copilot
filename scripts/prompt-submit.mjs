#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { hookCwd, printContinue, failOpen } from "./lib/hook-output.mjs";
import { recordPrompt } from "./lib/daily-log.mjs";
import { ompRoot } from "./lib/omp-root.mjs";

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

function appendLog(directory, payload) {
  const logFile = join(ompRoot(directory), ".omp", "state", "hooks.log");
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
    const directory = hookCwd(data);
    const prompt = data.prompt ?? data.message?.content ?? "";
    appendLog(directory, { sessionId, promptBytes: String(prompt).length });
    // Count this prompt as session work (signals the SessionEnd nudge logic).
    // Injects nothing — keeps per-turn token cost at zero.
    try {
      recordPrompt(directory);
    } catch {
      // best effort: counting must never block the prompt
    }
    const parts = [];
    const cont = buildContinuationContext(directory);
    if (cont) parts.push(cont);
    const additionalContext = parts.join("\n\n---\n\n");
    printContinue(HOOK_NAME, additionalContext);
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
