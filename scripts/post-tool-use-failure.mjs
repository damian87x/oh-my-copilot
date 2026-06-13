#!/usr/bin/env node
import { readStdin } from "./lib/stdin.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";
import { appendHookLog, failOpen } from "./lib/hook-output.mjs";

const HOOK_NAME = "postToolUseFailure";

(async () => {
  try {
    const input = parseHookInput(await readStdin());
    appendHookLog(input.cwd, HOOK_NAME, {
      sessionId: input.sessionId,
      toolName: input.toolName,
      error: input.error ?? "unknown",
    });
    failOpen();
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    failOpen();
  }
})();
