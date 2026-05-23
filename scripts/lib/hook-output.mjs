import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function printContinue(hookEventName, additionalContext = "") {
  const output = additionalContext
    ? { continue: true, hookSpecificOutput: { hookEventName, additionalContext } }
    : { continue: true };
  console.log(JSON.stringify(output));
}

export function printBlock(reason) {
  console.log(JSON.stringify({ continue: false, reason }));
}

export function failOpen() {
  console.log(JSON.stringify({ continue: true }));
}

export function appendHookLog(directory, hookName, payload) {
  const logFile = join(directory, ".omp", "state", "hooks.log");
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
