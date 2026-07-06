#!/usr/bin/env node
// Copilot CLI `agentStop` hook: drives the omp persistence loops (ralph /
// ultrawork / ultraqa). When a loop is active and not yet complete, returns
// {decision:"block", reason:"<next-turn prompt>"} so Copilot takes another turn;
// otherwise {decision:"allow"}. Fail-OPEN (never traps the user in a loop).
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readStdin } from "./lib/stdin.mjs";
import { buildStopDecisionOutput, appendHookLog, printStopDecision } from "./lib/hook-output.mjs";
import { decideLoop, extractAssistantText, LOOP_MODES } from "./lib/loop-driver.mjs";
import { ompRoot } from "./lib/omp-root.mjs";
import { parseHookInput } from "./lib/hook-input.mjs";

const HOOK_NAME = "agentStop";
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
// Copilot CLI 1.0.68 fires every hook twice ~50ms apart (#76). Real consecutive
// stops are separated by a full model turn (seconds), so a short replay window
// distinguishes duplicates from genuine next stops.
const DEDUPE_WINDOW_MS_DEFAULT = 3000;

// Unified-root invariant: loop state is always read/written under ompRoot(cwd)
// so the CLI and hooks patch the same counter file from repository subdirs.
export function stateFile(directory, mode) {
  const root = ompRoot(directory);
  return join(root, ".omp", "state", `${mode}.json`);
}

export function agentStopLocksDir(directory) {
  return join(ompRoot(directory), ".omp", "state", "locks");
}

function safePathPart(value) {
  const safe = String(value ?? "unknown").replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "unknown";
}

function startedAtMillis(startedAt) {
  const ms = typeof startedAt === "number" ? startedAt : Date.parse(String(startedAt ?? ""));
  if (!Number.isFinite(ms)) throw new Error("missing startedAt nonce");
  return String(Math.trunc(ms));
}

function agentStopMarkerName(mode, sessionId, startedAt, counterValue) {
  return [
    "agentstop",
    safePathPart(mode),
    safePathPart(sessionId),
    startedAtMillis(startedAt),
    safePathPart(counterValue),
  ].join("-");
}

export function clearAgentStopMarkers(directory, mode) {
  try {
    const locks = agentStopLocksDir(directory);
    const prefix = `agentstop-${safePathPart(mode)}-`;
    for (const name of readdirSync(locks)) {
      if (name.startsWith(prefix)) unlinkSync(join(locks, name));
    }
  } catch {
    // best effort
  }
}

// Roll back a single claimed marker. Used when the counter write fails after
// the marker was created: without this the stale marker would make the next
// stop hit EEXIST and skip counting, freezing the loop budget.
export function releaseAgentStopMarker({ directory, mode, sessionId, startedAt, counterValue }) {
  try {
    const locks = agentStopLocksDir(directory);
    unlinkSync(join(locks, agentStopMarkerName(mode, sessionId, startedAt, counterValue)));
  } catch {
    // best effort — nothing to roll back if the marker is already gone
  }
}

export function claimAgentStopCounter({ directory, mode, sessionId, startedAt, counterValue }) {
  const locks = agentStopLocksDir(directory);
  try {
    mkdirSync(locks, { recursive: true });
  } catch {
    return true; // guard errors fail open toward counting
  }

  let marker;
  try {
    marker = join(locks, agentStopMarkerName(mode, sessionId, startedAt, counterValue));
  } catch {
    return true; // guard errors fail open toward counting
  }

  let fd;
  try {
    fd = openSync(marker, "wx");
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    return true; // guard errors fail open toward counting
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

function decisionCachePath(directory, sessionId) {
  return join(agentStopLocksDir(directory), `agentstop-decision-${safePathPart(sessionId)}.json`);
}

// Duplicate-fire guard (#76): the second concurrent fire must return the SAME
// decision (and block reason) as the first instead of recomputing against
// already-advanced loop state — recomputation can flip block→allow and kill
// the loop. Fail-open: any cache error falls back to normal processing.
function readRecentDecision(directory, sessionId, windowMs) {
  try {
    const cached = JSON.parse(readFileSync(decisionCachePath(directory, sessionId), "utf8"));
    const age = Date.now() - Number(cached.ts);
    if (Number.isFinite(age) && age >= 0 && age < windowMs) return cached;
  } catch {
    // no cache or unreadable — compute normally
  }
  return undefined;
}

function cacheDecision(directory, sessionId, decision, reason) {
  try {
    const p = decisionCachePath(directory, sessionId);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify({ ts: Date.now(), decision, reason }), "utf8");
    renameSync(tmp, p);
  } catch {
    // best effort
  }
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

function writeState(directory, mode, state) {
  const p = stateFile(directory, mode);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, p);
}

// Read only the tail of the transcript — it can be large, and a completion
// sentinel from this turn lives at the end.
function readTranscriptTail(path) {
  if (!path || !existsSync(path)) return "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = size - start;
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
  const input = parseHookInput(raw);
  const directory = input.cwd;
  const sessionId = input.sessionId;

  // Team workers run inside the parent project and share its `.omp/state`.
  // Without this guard they'd inherit the parent's active ralph/ultrawork/
  // ultraqa loop and the hook would inject "[RALPH ITERATION N]" into a worker
  // that has no loop context (it hijacks the worker's assigned lane task). The
  // team launcher tags workers with OMP_TEAM_WORKER so they always stop normally.
  if (env.OMP_TEAM_WORKER) {
    appendHookLog(directory, HOOK_NAME, { decision: "allow", reason: "team worker — loop injection skipped" });
    return buildStopDecisionOutput("allow");
  }

  const dedupeRaw = Number(env.OMP_AGENTSTOP_DEDUPE_MS ?? DEDUPE_WINDOW_MS_DEFAULT);
  const dedupeWindowMs = Number.isFinite(dedupeRaw) && dedupeRaw >= 0 ? dedupeRaw : DEDUPE_WINDOW_MS_DEFAULT;
  if (dedupeWindowMs > 0) {
    const replay = readRecentDecision(directory, sessionId, dedupeWindowMs);
    if (replay) {
      appendHookLog(directory, HOOK_NAME, { decision: replay.decision, reason: replay.reason, deduped: true });
      return buildStopDecisionOutput(replay.decision, replay.decision === "block" ? (replay.reason ?? "") : "");
    }
  }

  const states = {};
  for (const m of LOOP_MODES) states[m.key] = readState(directory, m.key);

  const transcript = extractAssistantText(readTranscriptTail(input.transcriptPath));
  const result = decideLoop(states, transcript);

  // Persist counter increment (block) or clear the loop (allow on complete/cap).
  if (result.patch) {
    const s = states[result.patch.mode];
    if (s) {
      // Narrow guarantee: concurrent double-fires for the same observed counter
      // value cannot double-count; sequential double-fires may advance again.
      const shouldCount = claimAgentStopCounter({
        directory,
        mode: result.patch.mode,
        sessionId,
        startedAt: s.startedAt,
        counterValue: result.patch.value,
      });
      if (shouldCount) {
        s[result.patch.counter] = result.patch.value;
        try {
          writeState(directory, result.patch.mode, s);
        } catch {
          // Write failed after the marker was claimed — roll back the marker so
          // the next stop can re-count instead of freezing on a stale EEXIST.
          releaseAgentStopMarker({
            directory,
            mode: result.patch.mode,
            sessionId,
            startedAt: s.startedAt,
            counterValue: result.patch.value,
          });
        }
      }
    }
  } else if (result.clear) {
    const s = states[result.clear];
    if (s) {
      s.active = false;
      try {
        writeState(directory, result.clear, s);
      } catch {
        // best effort
      }
    }
    clearAgentStopMarkers(directory, result.clear);
  }

  if (dedupeWindowMs > 0) cacheDecision(directory, sessionId, result.decision, result.reason);
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
