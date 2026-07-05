#!/usr/bin/env node
// Copilot CLI `agentStop` hook: drives the omp persistence loops (ralph /
// ultrawork / ultraqa). When a loop is active and not yet complete, returns
// {decision:"block", reason:"<next-turn prompt>"} so Copilot takes another turn;
// otherwise {decision:"allow"}. Fail-OPEN (never traps the user in a loop).
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readStdin } from "./lib/stdin.mjs";
import { hookCwd, buildStopDecisionOutput, appendHookLog, printStopDecision } from "./lib/hook-output.mjs";
import { decideLoop, LOOP_MODES } from "./lib/loop-driver.mjs";
import { ompRoot } from "./lib/omp-root.mjs";

const HOOK_NAME = "agentStop";
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

// Unified-root invariant: loop state is always read/written under ompRoot(cwd)
// so the CLI and hooks patch the same counter file from repository subdirs.
export function stateFile(directory, mode) {
  const root = ompRoot(directory);
  return join(root, ".omp", "state", `${mode}.json`);
}

function readState(directory, mode) {
  const p = stateFile(directory, mode);
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

export function handleAgentStop(raw, env = process.env) {
  const data = raw ? JSON.parse(raw) : {};
  const directory = hookCwd(data);

  // Team workers run inside the parent project and share its `.omp/state`.
  // Without this guard they'd inherit the parent's active ralph/ultrawork/
  // ultraqa loop and the hook would inject "[RALPH ITERATION N]" into a worker
  // that has no loop context (it hijacks the worker's assigned lane task). The
  // team launcher tags workers with OMP_TEAM_WORKER so they always stop normally.
  if (env.OMP_TEAM_WORKER) {
    appendHookLog(directory, HOOK_NAME, { decision: "allow", reason: "team worker — loop injection skipped" });
    return buildStopDecisionOutput("allow");
  }

  const states = {};
  for (const m of LOOP_MODES) states[m.key] = readState(directory, m.key);

  const transcript = readTranscriptTail(data.transcriptPath ?? data.transcript_path);
  const result = decideLoop(states, transcript);

  // Persist counter increment (block) or clear the loop (allow on complete/cap).
  if (result.patch) {
    const s = states[result.patch.mode];
    if (s) {
      s[result.patch.counter] = result.patch.value;
      try { writeFileSync(stateFile(directory, result.patch.mode), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
    }
  } else if (result.clear) {
    const s = states[result.clear];
    if (s) {
      s.active = false;
      try { writeFileSync(stateFile(directory, result.clear), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
    }
  }

  appendHookLog(directory, HOOK_NAME, { decision: result.decision, reason: result.reason });
  return buildStopDecisionOutput(result.decision, result.decision === "block" ? result.reason : "");
}

async function main() {
  try {
    const raw = await readStdin();
    console.log(JSON.stringify(handleAgentStop(raw)));
  } catch (err) {
    console.error(`[hook ${HOOK_NAME}] failed: ${err?.message ?? err}`);
    printStopDecision("allow"); // fail-open: never trap the loop on an error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
