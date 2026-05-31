import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

// The repo's durable objective ("what we want to achieve in this repo"), stored
// once per project at .omp/goal.md — distinct from a daily log's per-day goal.
function goalFile(cwd: string): string {
  return join(resolve(cwd), ".omp", "goal.md");
}

// Strip ONLY our own serialized `# Repo Goal` header (not any heading), so a
// hand-authored objective — even one that starts with `#` — is never lost.
function parseGoal(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.split("\n");
  if (/^#\s+Repo Goal\s*$/i.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n").trim();
}

function readGoal(cwd: string): string {
  const p = goalFile(cwd);
  if (!existsSync(p)) return "";
  try {
    return parseGoal(readFileSync(p, "utf8"));
  } catch {
    return "";
  }
}

function writeGoal(cwd: string, goal: string): void {
  const p = goalFile(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `# Repo Goal\n\n${goal.trim()}\n`, "utf8");
  renameSync(tmp, p);
}

export const goalTools: ToolDefinition[] = [
  {
    name: "goal_set",
    category: "goal",
    description:
      "Set/replace the repo's durable objective (what we want to achieve in this repo), stored at .omp/goal.md.",
    inputSchema: {
      type: "object",
      properties: { goal: { type: "string" }, cwd: { type: "string" } },
      required: ["goal"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      // Collapse to a single line: the repo goal is a one-line north-star.
      const goal = String(args.goal ?? "")
        .replace(/\s*\n\s*/g, " ")
        .trim();
      if (!goal) return jsonResult({ ok: false, error: "goal is required" });
      writeGoal(cwd, goal);
      return jsonResult({ ok: true, goal });
    },
  },
  {
    name: "goal_read",
    category: "goal",
    description: "Read the repo's durable objective from .omp/goal.md.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      return textResult(readGoal(cwd) || "(no repo goal set)");
    },
  },
];
