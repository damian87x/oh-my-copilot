import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
export const NUDGE_INTERVAL = 10;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dailyDir(directory) {
  return join(resolve(directory), ".omp", "memory", "daily");
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
  return join(resolve(directory), ".omp", "state", "daily-log.json");
}

/**
 * Increment today's prompt counter (resetting across a day boundary) and report
 * whether a nudge is due (every NUDGE_INTERVAL prompts). Best-effort, never throws.
 */
export function bumpPromptCount(directory) {
  const today = todayStr();
  const p = statePath(directory);
  let state = { date: today, promptCount: 0, lastNudgeAt: 0 };
  try {
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      // Guard against valid-but-wrong JSON (null, number, array) so state.date
      // below can't throw — keeps the "never throws" contract honest.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed;
    }
  } catch {
    // start fresh on parse failure
  }
  if (state.date !== today) state = { date: today, promptCount: 0, lastNudgeAt: 0 };
  state.promptCount = (state.promptCount || 0) + 1;
  const nudgeDue = state.promptCount - (state.lastNudgeAt || 0) >= NUDGE_INTERVAL;
  if (nudgeDue) state.lastNudgeAt = state.promptCount;
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, p);
  } catch {
    // best effort
  }
  return { state, nudgeDue };
}
