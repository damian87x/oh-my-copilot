import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Hook scripts run under BOTH GitHub Copilot CLI (camelCase events, top-level
// `additionalContext` / `{decision,reason}` / `{permissionDecision}`) and Claude
// Code (`{continue, hookSpecificOutput}` / `{decision, reason}`). The injection
// path (`printContinue`) dual-emits: every output object carries both
// vocabularies, and each host ignores the keys it does not recognize. See
// docs/plans/copilot-native-hooks.md.
//
// The cost/minification path uses the documented Copilot builder shapes
// (`buildContinueOutput`/`buildAdditionalContextOutput`/`buildModifiedResultOutput`/
// `buildPermissionDecisionOutput`). An empty `{}` is a no-op "continue" for both
// hosts, so these builders coexist with the dual-emit injection path.

/** Project directory from hook input — Copilot sends `cwd`, Claude sends `directory`. */
export function hookCwd(data) {
  return data?.cwd ?? data?.directory ?? process.cwd();
}

export function buildContinueOutput() {
  return {};
}

export function buildAdditionalContextOutput(additionalContext = "") {
  return additionalContext ? { additionalContext } : buildContinueOutput();
}

export function buildContinueHookOutput(hookEventName, additionalContext = "") {
  if (!additionalContext) return buildContinueOutput();
  return {
    continue: true,
    additionalContext, // Copilot CLI
    hookSpecificOutput: { hookEventName, additionalContext }, // Claude Code
  };
}

export function buildModifiedResultOutput(textResultForLlm, additionalContext = "", resultType = "success") {
  return {
    modifiedResult: {
      resultType,
      textResultForLlm,
    },
    ...(additionalContext ? { additionalContext } : {}),
  };
}

export function buildPermissionDecisionOutput(permissionDecision, permissionDecisionReason, modifiedArgs) {
  return {
    permissionDecision,
    ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
    ...(modifiedArgs == null ? {} : { modifiedArgs }),
  };
}

/**
 * sessionStart / userPromptSubmitted injection. When there is context to inject,
 * dual-emit it for both hosts (Copilot top-level `additionalContext` + Claude
 * `continue`/`hookSpecificOutput`). With nothing to inject, emit an empty `{}` —
 * a no-op "continue" understood by both hosts and the zero-cost default.
 */
export function printContinue(hookEventName, additionalContext = "") {
  console.log(JSON.stringify(buildContinueHookOutput(hookEventName, additionalContext)));
}

/** agentStop (Copilot) / Stop (Claude): both honor {decision, reason}. */
export function buildStopDecisionOutput(decision, reason = "") {
  const out = { decision }; // "block" forces another turn; "allow" lets it stop
  if (reason) out.reason = reason; // serves as the next-turn prompt when blocked
  return out;
}

export function printStopDecision(decision, reason = "") {
  const out = buildStopDecisionOutput(decision, reason);
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
  console.log(JSON.stringify(buildPermissionDecisionOutput("deny", reason)));
}

export function failOpen() {
  console.log(JSON.stringify(buildContinueOutput()));
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
