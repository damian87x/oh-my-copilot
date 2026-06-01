import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";
import { readRepoGoal } from "./goal.js";
import { readDirectives, noteIndex } from "./project-memory.js";

// Copilot CLI does not execute plugin lifecycle hooks (verified: neither
// SessionStart nor UserPromptSubmit fire), so we can't inject memory via hooks.
// Copilot DOES read .github/copilot-instructions.md, so we render the always-on
// memory (repo goal + directives) into a managed block there. The block is
// refreshed whenever goal/directives/notes change, so it appears every session.

const START = "<!-- omp:memory:start -->";
const END = "<!-- omp:memory:end -->";
const MAX_DIRECTIVES = 20;

function instructionsPath(cwd: string): string {
  return join(ompRoot(cwd), ".github", "copilot-instructions.md");
}

function renderBlock(cwd: string): string {
  const goal = readRepoGoal(cwd);
  const directives = readDirectives(cwd);
  const notes = noteIndex(cwd);
  const lines: string[] = [START, "## Active memory (managed by omp — do not edit between these markers)"];
  if (goal) lines.push("", `**Repo goal:** ${goal}`);
  if (directives.length > 0) {
    lines.push("", "**Directives — must follow this session:**");
    for (const d of directives.slice(0, MAX_DIRECTIVES)) lines.push(`- ${d}`);
    if (directives.length > MAX_DIRECTIVES) lines.push(`- (+${directives.length - MAX_DIRECTIVES} more — \`omp project-memory read\`)`);
  }
  lines.push(
    "",
    `**On demand:** \`omp project-memory index\` (${notes.length} note${notes.length === 1 ? "" : "s"}) · \`omp project-memory read <id>\` · \`omp daily-log read\``,
    END,
  );
  return lines.join("\n");
}

/**
 * Write/refresh the managed memory block in .github/copilot-instructions.md so
 * Copilot surfaces it every session. Creates the file if absent. Returns the
 * path and whether a block was written. Best-effort; never throws.
 */
export function syncInstructionsMemory(cwd: string): { path: string; wrote: boolean } {
  const p = instructionsPath(cwd);
  const block = renderBlock(cwd);
  try {
    let content = existsSync(p) ? readFileSync(p, "utf8") : "";
    const s = content.indexOf(START);
    const e = content.indexOf(END);
    if (s !== -1 && e !== -1 && e > s) {
      content = content.slice(0, s) + block + content.slice(e + END.length);
    } else if (content.trim() === "") {
      content = `# oh-my-copilot\n\n${block}\n`;
    } else {
      content = `${content.trimEnd()}\n\n${block}\n`;
    }
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, p);
    return { path: p, wrote: true };
  } catch {
    return { path: p, wrote: false };
  }
}
