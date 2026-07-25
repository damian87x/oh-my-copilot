import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWrite, ensureDir } from "./utils/fs.js";
import { ompPath } from "./utils/paths.js";

// The project's durable objective ("what we want to achieve in this repo"), stored
// once per project at .omp/goal.md — distinct from a daily log's per-day goal.
// Exposed through `omp project-goal` (NOT MCP), so the project directory
// is the CLI's cwd and never ambiguous.
function projectGoalFile(cwd: string): string {
  return ompPath(cwd, "goal.md");
}

// Strip ONLY the historical serialized `# Repo Goal` header (not any heading), so a
// hand-authored objective — even one that starts with `#` — is never lost.
function parseProjectGoal(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.split("\n");
  if (/^#\s+Repo Goal\s*$/i.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n").trim();
}

/** The repo objective, or "" when unset. */
export function readProjectGoal(cwd: string): string {
  const p = projectGoalFile(cwd);
  if (!existsSync(p)) return "";
  try {
    return parseProjectGoal(readFileSync(p, "utf8"));
  } catch {
    return "";
  }
}

/** Set/replace the repo objective (collapsed to one north-star line). */
export function writeProjectGoal(cwd: string, goal: string): string {
  const clean = String(goal ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const p = projectGoalFile(cwd);
  ensureDir(p);
  atomicWrite(p, `# Repo Goal\n\n${clean}\n`);
  return clean;
}

export function clearProjectGoal(cwd: string): boolean {
  const p = projectGoalFile(cwd);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
