import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

export function buildContinueOutput() {
  return {};
}

export function buildAdditionalContextOutput(additionalContext = "") {
  return additionalContext ? { additionalContext } : buildContinueOutput();
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

export function printContinue(hookEventName, additionalContext = "") {
  void hookEventName;
  console.log(JSON.stringify(buildAdditionalContextOutput(additionalContext)));
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
