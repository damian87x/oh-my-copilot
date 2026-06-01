import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// The repo's durable objective ("what we want to achieve in this repo"), stored
// once per project at .omp/goal.md — distinct from a daily log's per-day goal.
// Exposed through the `omp goal` CLI subcommands (NOT MCP), so the project dir
// is the CLI's cwd and never ambiguous.
function goalFile(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "goal.md");
}

// Strip ONLY our own serialized `# Repo Goal` header (not any heading), so a
// hand-authored objective — even one that starts with `#` — is never lost.
function parseGoal(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.split("\n");
  if (/^#\s+Repo Goal\s*$/i.test(lines[0] ?? "")) lines.shift();
  return lines.join("\n").trim();
}

/** The repo objective, or "" when unset. */
export function readRepoGoal(cwd: string): string {
  const p = goalFile(cwd);
  if (!existsSync(p)) return "";
  try {
    return parseGoal(readFileSync(p, "utf8"));
  } catch {
    return "";
  }
}

/** Set/replace the repo objective (collapsed to one north-star line). */
export function writeRepoGoal(cwd: string, goal: string): string {
  const clean = String(goal ?? "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  const p = goalFile(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `# Repo Goal\n\n${clean}\n`, "utf8");
  renameSync(tmp, p);
  return clean;
}
