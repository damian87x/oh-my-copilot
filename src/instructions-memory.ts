import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";
import { readRepoGoal } from "./goal.js";
import { noteIndex } from "./project-memory.js";

// Copilot CLI can inject memory via the `sessionStart` hook's `additionalContext`
// (see hooks/hooks.json + scripts/session-start.mjs, ported to Copilot's hook
// schema). This copilot-instructions.md block remains the always-on fallback: it
// works even when hooks are disabled or in headless `copilot -p` (which skips
// hooks). The block keeps the repo goal visible but leaves project memory and
// daily logs on demand to avoid bloating or over-steering context.

const START = "<!-- omp:memory:start -->";
const END = "<!-- omp:memory:end -->";

function instructionsPath(cwd: string): string {
  return join(ompRoot(cwd), ".github", "copilot-instructions.md");
}

function renderBlock(cwd: string): string {
  const goal = readRepoGoal(cwd);
  const notes = noteIndex(cwd);
  const lines: string[] = [START, "## oh-my-copilot project context"];
  if (goal) lines.push("", `**Repo goal:** ${goal}`);
  lines.push(
    "",
    "Project memory is available on demand:",
    "- `omp project-memory read` for project hints and the note index",
    "- `omp project-memory read <id>` for a specific note body",
    "- `omp daily-log read --days 7` for recent daily context",
    "",
    `Available note index: ${notes.length} note${notes.length === 1 ? "" : "s"}.`,
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
  if (process.env.OMP_DISABLE_INSTRUCTIONS_MEMORY) return { path: p, wrote: false };
  const block = renderBlock(cwd);
  try {
    const content = existsSync(p) ? readFileSync(p, "utf8") : "";
    const starts = content.split(START).length - 1;
    const ends = content.split(END).length - 1;
    let next: string;
    if (starts === 1 && ends === 1) {
      const s = content.indexOf(START);
      const e = content.indexOf(END);
      if (e <= s) return { path: p, wrote: false }; // markers out of order — don't risk a clobber
      next = content.slice(0, s) + block + content.slice(e + END.length);
    } else if (starts === 0 && ends === 0) {
      next = content.trim() === "" ? `# oh-my-copilot\n\n${block}\n` : `${content.trimEnd()}\n\n${block}\n`;
    } else {
      // Orphan or duplicate markers = corrupt managed region. Fail closed rather
      // than risk replacing user content between mismatched markers.
      return { path: p, wrote: false };
    }
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, p);
    return { path: p, wrote: true };
  } catch {
    return { path: p, wrote: false };
  }
}
