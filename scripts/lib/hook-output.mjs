import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Hook scripts run under BOTH GitHub Copilot CLI (camelCase events, top-level
// `additionalContext` / `{decision,reason}` / `{permissionDecision}`) and Claude
// Code (`{continue, hookSpecificOutput}` / `{decision, reason}`). We dual-emit:
// every output object carries both vocabularies, and each host ignores the keys
// it does not recognize. See docs/plans/copilot-native-hooks.md.

/** Project directory from hook input — Copilot sends `cwd`, Claude sends `directory`. */
export function hookCwd(data) {
  return data?.cwd ?? data?.directory ?? process.cwd();
}

/** sessionStart / postToolUse style: inject `additionalContext` (or a plain continue). */
export function printContinue(hookEventName, additionalContext = "") {
  const output = { continue: true };
  if (additionalContext) {
    output.additionalContext = additionalContext; // Copilot CLI
    output.hookSpecificOutput = { hookEventName, additionalContext }; // Claude Code
  }
  console.log(JSON.stringify(output));
}

/** agentStop (Copilot) / Stop (Claude): both honor {decision, reason}. */
export function printStopDecision(decision, reason = "") {
  const out = { decision }; // "block" forces another turn; "allow" lets it stop
  if (reason) out.reason = reason; // serves as the next-turn prompt when blocked
  console.log(JSON.stringify(out));
}

/** preToolUse (Copilot): allow | deny | ask, with optional reason / modified args. */
export function printPermission(permissionDecision, reason = "", modifiedArgs) {
  const out = { permissionDecision };
  if (reason) out.permissionDecisionReason = reason;
  if (modifiedArgs) out.modifiedArgs = modifiedArgs;
  console.log(JSON.stringify(out));
}

export function printBlock(reason) {
  console.log(JSON.stringify({ continue: false, reason }));
}

export function failOpen() {
  console.log(JSON.stringify({ continue: true }));
}

export function appendHookLog(directory, hookName, payload) {
  const logFile = join(ompRoot(directory), ".omp", "state", "hooks.log");
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ ts: new Date().toISOString(), hook: hookName, ...payload })}\n`,
    );
  } catch {
    // best effort
  }
}
