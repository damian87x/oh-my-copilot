import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// Core read/write logic for the per-project daily log at
// .omp/memory/daily/<YYYY-MM-DD>.md (# date / ## Goal / ## Log). Exposed to the
// model through the `omp daily-log` CLI subcommands (NOT MCP), so the project
// dir is the CLI's cwd and never ambiguous.

interface DayDoc {
  goal: string;
  log: string[];
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const READ_CHAR_BUDGET = 4000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStr(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dailyDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "memory", "daily");
}

function dayFile(cwd: string, date = todayStr()): string {
  return join(dailyDir(cwd), `${date}.md`);
}

function parseDay(text: string): DayDoc {
  let section: "goal" | "log" | null = null;
  const goalLines: string[] = [];
  const log: string[] = [];
  for (const line of text.split("\n")) {
    if (/^#\s+/.test(line)) continue;
    if (/^##\s+Goal\s*$/i.test(line)) {
      section = "goal";
      continue;
    }
    if (/^##\s+Log\s*$/i.test(line)) {
      section = "log";
      continue;
    }
    if (section === "goal") goalLines.push(line);
    // Preserve any non-empty line a user may have hand-written, verbatim (bullets,
    // prose, indented sub-notes). Only blank spacer lines are dropped on round-trip.
    else if (section === "log" && line.trim() !== "") log.push(line);
  }
  return { goal: goalLines.join("\n").trim(), log };
}

function serializeDay(date: string, doc: DayDoc): string {
  const parts = [`# ${date}`, "", "## Goal", doc.goal.trim(), "", "## Log", ...doc.log];
  return `${parts.join("\n").replace(/\n+$/, "")}\n`;
}

function readDay(cwd: string, date = todayStr()): DayDoc {
  const p = dayFile(cwd, date);
  if (!existsSync(p)) return { goal: "", log: [] };
  try {
    return parseDay(readFileSync(p, "utf8"));
  } catch {
    return { goal: "", log: [] };
  }
}

function writeDay(cwd: string, doc: DayDoc, date = todayStr()): void {
  const p = dayFile(cwd, date);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, serializeDay(date, doc), "utf8");
  renameSync(tmp, p);
}

/** Set/replace today's goal. Returns the date and stored goal. */
export function setDailyGoal(cwd: string, goal: string): { date: string; goal: string } {
  const doc = readDay(cwd);
  doc.goal = String(goal ?? "").trim();
  writeDay(cwd, doc);
  return { date: todayStr(), goal: doc.goal };
}

/** Append a timestamped entry (`- HH:MM — <text>`) to today's log. */
export function addLogEntry(cwd: string, text: string): { date: string; count: number } {
  // Collapse to a single line so an entry can never contain a `## Goal`/`## Log`
  // marker that parseDay would later misread as a section boundary.
  const clean = String(text ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const doc = readDay(cwd);
  doc.log.push(`- ${timeStr()} — ${clean}`);
  writeDay(cwd, doc);
  return { date: todayStr(), count: doc.log.length };
}

/**
 * Delete day-files older than `keepDays` days; returns the removed dates.
 * Daily files already age out of context (only a breadcrumb is injected and
 * reads are recency-bounded), so this is disk housekeeping, not a context fix.
 */
export function pruneDailyLog(cwd: string, keepDays: number): string[] {
  const dir = dailyDir(cwd);
  if (!existsSync(dir)) return [];
  const cutoff = todayStr(new Date(Date.now() - Math.max(0, keepDays) * 86400000));
  const removed: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!DAY_FILE_RE.test(f)) continue;
    const date = f.slice(0, 10);
    if (date < cutoff) {
      try {
        unlinkSync(join(dir, f));
        removed.push(date);
      } catch {
        // skip unremovable file
      }
    }
  }
  return removed.sort();
}

/** Read today + the previous `days` days, newest-first, capped to ~4KB. */
export function readDailyLog(cwd: string, days: number): string {
  const dir = dailyDir(cwd);
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir)
    .filter((f) => DAY_FILE_RE.test(f))
    .sort()
    .reverse()
    .slice(0, Math.max(0, days) + 1);
  let out = "";
  for (const f of files) {
    try {
      out += `${readFileSync(join(dir, f), "utf8").trim()}\n\n`;
    } catch {
      // skip unreadable day file
    }
    if (out.length > READ_CHAR_BUDGET) {
      out = `${out.slice(0, READ_CHAR_BUDGET)}\n…(truncated)`;
      break;
    }
  }
  return out.trim();
}
