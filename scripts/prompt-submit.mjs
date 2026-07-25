#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { isMain } from "./lib/is-main.mjs";
import { buildContinueHookOutput, failOpen } from "./lib/hook-output.mjs";
import { recordPrompt } from "./lib/daily-log.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";
import { appendCostRecord, countTokens } from "./lib/cost-ledger.mjs";
import { formatGoalContext, goalCommand } from "./lib/goal-runtime.mjs";
import {
  formatUltragoalContext,
  readUltragoalManifest,
  selectUltragoalForGoal,
} from "./lib/ultragoal-context.mjs";

const HOOK_NAME = "UserPromptSubmit";

export function readModeState(directory, mode) {
  const p = join(ompRoot(directory), ".omp", "state", `${mode}.json`);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function buildContinuationContext(directory, sessionId) {
  const ralph = readModeState(directory, "ralph");
  const ultrawork = readModeState(directory, "ultrawork");
  const ultraqa = readModeState(directory, "ultraqa");
  const parts = [];
  const goal = sessionId && sessionId !== "unknown"
    ? goalCommand({ root: directory, command: "status", sessionId })
    : undefined;
  // Busy/corrupt Goal status must not fall through to global loop injection.
  const goalUnavailable = Boolean(goal && !goal.ok);
  const goalState = goal?.ok ? goal.result : undefined;
  const goalContext =
    goalState?.status === "active" || goalState?.status === "paused"
      ? formatGoalContext(goalState)
      : "";
  if (goalContext) parts.push(goalContext);
  if (goalState?.status === "active") {
    const ultragoalContext = formatUltragoalContext(
      selectUltragoalForGoal(
        readUltragoalManifest(directory, sessionId),
        goalState.goalGeneration,
      ),
    );
    if (ultragoalContext) parts.push(ultragoalContext);
  }

  if (goalState?.status === "active") {
    // Strict nesting: inject only the highest-ranked active frame owned by the
    // same session (ralph > ultraqa > ultrawork).
    if (ralph?.active && ralph.sessionId === sessionId) {
      parts.push(
        `[RALPH ACTIVE: iteration ${ralph.iteration}/${ralph.maxIterations}]\nPrompt: ${ralph.prompt}\nContinue the loop. Report concrete progress.`,
      );
    } else if (ultraqa?.active && ultraqa.sessionId === sessionId) {
      parts.push(
        `[ULTRAQA ACTIVE: cycle ${ultraqa.cycleCount}/${ultraqa.maxCycles}]\nGoal: ${ultraqa.goal}\nRun tests → verify → fix. Iterate.`,
      );
    } else if (ultrawork?.active && ultrawork.sessionId === sessionId) {
      parts.push(
        `[ULTRAWORK ACTIVE]\nObjective: ${ultrawork.objective}\nSustain the objective. Batch parallel tasks.`,
      );
    }
  } else if (!goalUnavailable && (!goalState || goalState.status === "empty")) {
    // Backward-compatible global mode behavior when no session Goal exists.
    // Skip entirely when Goal status failed (busy/corrupt) so nested sessions
    // never receive unscoped ralph/ultraqa/ultrawork frames mid-mutation.
    if (ralph?.active)
      parts.push(
        `[RALPH ACTIVE: iteration ${ralph.iteration}/${ralph.maxIterations}]\nPrompt: ${ralph.prompt}\nContinue the loop. Report concrete progress.`,
      );
    if (ultraqa?.active)
      parts.push(
        `[ULTRAQA ACTIVE: cycle ${ultraqa.cycleCount}/${ultraqa.maxCycles}]\nGoal: ${ultraqa.goal}\nRun tests → verify → fix. Iterate.`,
      );
    if (ultrawork?.active)
      parts.push(
        `[ULTRAWORK ACTIVE]\nObjective: ${ultrawork.objective}\nSustain the objective. Batch parallel tasks.`,
      );
  }
  const ponytail = readModeState(directory, "ponytail");
  if (ponytail?.active)
    parts.push(
      `[PONYTAIL ACTIVE: ${ponytail.level}]\n` +
        "Lazy senior dev mode. After understanding the problem, stop at the first rung that holds: " +
        "1 needed at all? (YAGNI) 2 already here? reuse 3 stdlib? use it 4 native platform? use it " +
        "5 installed dep? use it 6 one line? one line 7 only then the minimum that works. " +
        "Never lazy about validation at trust boundaries, data-loss handling, security, accessibility, " +
        "or anything requested; non-trivial logic leaves one runnable check behind.",
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

export async function handlePromptSubmit(raw) {
  const input = parseHookInput(raw);
  const sessionId = input.sessionId;
  const directory = input.cwd;
  const prompt = input.prompt;
  appendLog(directory, { sessionId, promptBytes: String(prompt).length });
  appendCostRecord(directory, {
    sessionId,
    event: "userPromptSubmitted",
    inTokens: countTokens(prompt),
  });
  // Count this prompt as session work (signals the SessionEnd nudge logic).
  // Injects nothing — keeps per-turn token cost at zero.
  try {
    recordPrompt(directory, { sessionId, prompt, timestamp: input.timestamp });
  } catch {
    // best effort: counting must never block the prompt
  }
  const parts = [];
  const cont = buildContinuationContext(directory, sessionId);
  if (cont) parts.push(cont);
  const additionalContext = parts.join("\n\n---\n\n");
  return buildContinueHookOutput(HOOK_NAME, additionalContext);
}

async function main() {
  try {
    const raw = await readStdin();
    console.log(JSON.stringify(await handlePromptSubmit(raw)));
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
}

if (isMain(import.meta.url)) {
  main();
}
