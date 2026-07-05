import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const DEFAULT_NUDGE =
  'Your last session made progress but recorded nothing in the daily log — run `omp daily-log add "<text>"` to capture what changed and any key decisions, so this session has that context.';

// A session with at least this many user prompts counts as "did real work".
const WORK_THRESHOLD = 3;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dailyDir(directory) {
  return join(ompRoot(directory), ".omp", "memory", "daily");
}

function dayFile(directory, date = todayStr()) {
  return join(dailyDir(directory), `${date}.md`);
}

/** Today's Goal section text, or null when unset/empty. */
export function readTodayGoal(directory) {
  try {
    const p = dayFile(directory);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf8");
    const m = text.match(/##\s+Goal\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/i);
    const goal = m ? m[1].trim() : "";
    return goal || null;
  } catch {
    return null;
  }
}

/** The repo's durable objective from .omp/goal.md, or null when unset. */
export function readRepoGoal(directory) {
  try {
    const p = join(ompRoot(directory), ".omp", "goal.md");
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf8");
    const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split("\n");
    // Strip only our own `# Repo Goal` header so a hand-authored goal isn't lost.
    if (/^#\s+Repo Goal\s*$/i.test(lines[0] ?? "")) lines.shift();
    const goal = lines.join("\n").trim();
    return goal || null;
  } catch {
    return null;
  }
}

/** Count day-files + total log bullets within the last `days` days (inclusive). */
export function recentEntryStats(directory, days = 7) {
  try {
    const dir = dailyDir(directory);
    if (!existsSync(dir)) return { files: 0, entries: 0 };
    const cutoff = todayStr(new Date(Date.now() - days * 86400000));
    const files = readdirSync(dir).filter((f) => DAY_FILE_RE.test(f) && f.slice(0, 10) >= cutoff);
    let entries = 0;
    for (const f of files) {
      try {
        entries += (readFileSync(join(dir, f), "utf8").match(/^\s*-\s+/gm) || []).length;
      } catch {
        // skip unreadable day file
      }
    }
    return { files: files.length, entries };
  } catch {
    return { files: 0, entries: 0 };
  }
}

function statePath(directory) {
  return join(ompRoot(directory), ".omp", "state", "daily-log.json");
}

function locksDir(directory) {
  return join(ompRoot(directory), ".omp", "state", "locks");
}

function safePathPart(value) {
  const safe = String(value ?? "unknown").replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "unknown";
}

function promptHash(prompt) {
  return createHash("sha256").update(String(prompt ?? "")).digest("hex").slice(0, 24);
}

function timestampMs(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  const parsed = Date.parse(String(timestamp ?? ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function minuteBucket(timestamp) {
  return String(Math.floor(timestampMs(timestamp) / 60000));
}

function claimPromptRecord(directory, { sessionId = "unknown", prompt = "", timestamp = Date.now() } = {}) {
  const locks = locksDir(directory);
  try {
    mkdirSync(locks, { recursive: true });
  } catch {
    return true; // guard errors fail open toward counting
  }

  let marker;
  try {
    marker = join(
      locks,
      [
        "dailylog",
        safePathPart(sessionId),
        promptHash(prompt),
        minuteBucket(timestamp),
      ].join("-"),
    );
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

function readState(directory) {
  const fresh = { date: todayStr(), prompts: 0, entriesAtStart: 0, pendingNudge: false, pendingReason: "" };
  try {
    const p = statePath(directory);
    if (!existsSync(p)) return fresh;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    // Ignore valid-but-wrong JSON (null, number, array) so callers can't throw.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...fresh, ...parsed };
  } catch {
    // start fresh on read/parse failure
  }
  return fresh;
}

function writeState(directory, state) {
  try {
    const p = statePath(directory);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, p);
  } catch {
    // best effort
  }
}

/**
 * Called at SessionStart ("a new session continuing from an existing one").
 * Returns a one-line flush nudge when the PRIOR session did work but logged
 * nothing (else ""), then resets the per-session baseline. Never throws.
 */
export function startSession(directory) {
  const prior = readState(directory);
  const flush = prior.pendingNudge ? prior.pendingReason || DEFAULT_NUDGE : "";
  writeState(directory, {
    date: todayStr(),
    prompts: 0,
    entriesAtStart: recentEntryStats(directory, 0).entries,
    pendingNudge: false,
    pendingReason: "",
  });
  return flush;
}

/**
 * Called at UserPromptSubmit. Increments the per-session work counter.
 * Deliberately does NOT reset on day rollover — startSession owns the baseline,
 * so a session that spans midnight still counts all its prompts as one session.
 */
export function recordPrompt(directory, input = {}) {
  if (!claimPromptRecord(directory, input)) return;
  const state = readState(directory);
  state.prompts = (state.prompts || 0) + 1;
  writeState(directory, state);
}

/**
 * Called at SessionEnd. Arms a nudge for the NEXT SessionStart when this session
 * did real work (>= WORK_THRESHOLD prompts) but added no daily-log entries.
 * Never throws.
 */
export function endSession(directory) {
  const state = readState(directory);
  const sameDay = state.date === todayStr();
  const added = recentEntryStats(directory, 0).entries - (state.entriesAtStart || 0);
  const didWork = (state.prompts || 0) >= WORK_THRESHOLD;
  // Only arm when the session started and ended on the same calendar day. Across
  // a midnight boundary the entriesAtStart baseline refers to a different
  // day-file, so the delta is unreliable — stay quiet rather than risk a
  // spurious nudge.
  state.pendingNudge = sameDay && didWork && added <= 0;
  state.pendingReason = state.pendingNudge ? DEFAULT_NUDGE : "";
  writeState(directory, state);
}
