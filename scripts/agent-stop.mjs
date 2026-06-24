#!/usr/bin/env node
// Copilot CLI `agentStop` hook: drives the omp persistence loops (ralph /
// ultrawork / ultraqa). When a loop is active and not yet complete, returns
// {decision:"block", reason:"<next-turn prompt>"} so Copilot takes another turn;
// otherwise {decision:"allow"}. Fail-OPEN (never traps the user in a loop).
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { readStdin } from "./lib/stdin.mjs";
import { hookCwd, printStopDecision, appendHookLog } from "./lib/hook-output.mjs";
import { decideLoop, LOOP_MODES } from "./lib/loop-driver.mjs";

const HOOK_NAME = "agentStop";
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

// Match the omp CLI's modeStatePath (src/mode-state/paths.ts): literal resolved
// cwd, NOT ompRoot — so the hook reads/writes the exact files `omp ralph start`
// wrote, even when invoked from a subdirectory.
function stateFile(root, mode) {
  return join(root, ".omp", "state", `${mode}.json`);
}

function readState(root, mode) {
  const p = stateFile(root, mode);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

// Read only the tail of the transcript — it can be large, and a completion
// sentinel from this turn lives at the end.
function readTranscriptTail(path) {
  if (!path || !existsSync(path)) return "";
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

(async () => {
  try {
    const raw = await readStdin();
    const data = raw ? JSON.parse(raw) : {};
    const directory = hookCwd(data);

    // Team workers run inside the parent project and share its `.omp/state`.
    // Without this guard they'd inherit the parent's active ralph/ultrawork/
    // ultraqa loop and the hook would inject "[RALPH ITERATION N]" into a worker
    // that has no loop context (it hijacks the worker's assigned lane task). The
    // team launcher tags workers with OMP_TEAM_WORKER so they always stop normally.
    if (process.env.OMP_TEAM_WORKER) {
      appendHookLog(directory, HOOK_NAME, { decision: "allow", reason: "team worker — loop injection skipped" });
      printStopDecision("allow");
      return;
    }

    const root = resolve(directory);

    const states = {};
    for (const m of LOOP_MODES) states[m.key] = readState(root, m.key);

    const transcript = readTranscriptTail(data.transcriptPath ?? data.transcript_path);
    const result = decideLoop(states, transcript);

    // Persist counter increment (block) or clear the loop (allow on complete/cap).
    if (result.patch) {
      const s = states[result.patch.mode];
      if (s) {
        s[result.patch.counter] = result.patch.value;
        try { writeFileSync(stateFile(root, result.patch.mode), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
      }
    } else if (result.clear) {
      const s = states[result.clear];
      if (s) {
        s.active = false;
        try { writeFileSync(stateFile(root, result.clear), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
      }
    }

    appendHookLog(directory, HOOK_NAME, { decision: result.decision, reason: result.reason });
    printStopDecision(result.decision, result.decision === "block" ? result.reason : "");
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    printStopDecision("allow"); // fail-open: never trap the loop on an error
  }
})();
