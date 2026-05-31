import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

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
  return join(resolve(cwd), ".omp", "memory", "daily");
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

function readRecent(cwd: string, days: number): string {
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

export const dailyLogTools: ToolDefinition[] = [
  {
    name: "daily_log_set_goal",
    category: "daily_log",
    description: "Set/replace today's Goal in .omp/memory/daily/<today>.md.",
    inputSchema: {
      type: "object",
      properties: { goal: { type: "string" }, cwd: { type: "string" } },
      required: ["goal"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const doc = readDay(cwd);
      doc.goal = String(args.goal ?? "");
      writeDay(cwd, doc);
      return jsonResult({ ok: true, date: todayStr(), goal: doc.goal });
    },
  },
  {
    name: "daily_log_add",
    category: "daily_log",
    description: "Append a timestamped entry to today's Log in .omp/memory/daily/<today>.md.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, cwd: { type: "string" } },
      required: ["text"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      // Collapse to a single line so an entry can never contain a `## Goal`/`## Log`
      // marker that parseDay would later misread as a section boundary.
      const text = String(args.text ?? "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
      if (!text) return jsonResult({ ok: false, error: "text is required" });
      const doc = readDay(cwd);
      doc.log.push(`- ${timeStr()} — ${text}`);
      writeDay(cwd, doc);
      return jsonResult({ ok: true, date: todayStr(), count: doc.log.length });
    },
  },
  {
    name: "daily_log_read",
    category: "daily_log",
    description:
      "Read the daily log for today plus the previous `days` days (default 1). Char-capped to ~4KB.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number" }, cwd: { type: "string" } },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const days = typeof args.days === "number" ? (args.days as number) : 1;
      return textResult(readRecent(cwd, days) || "(no daily log entries)");
    },
  },
];
