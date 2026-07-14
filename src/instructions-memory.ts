import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";
import { readRepoGoal } from "./goal.js";
// Import store only (not the handoff barrel) so instruction sync does not pull git/trace.
import { listHandoffPointers } from "./handoff/store.js";
import { sanitizeForInstructions } from "./handoff/redact.js";
import { readMemoryConfig } from "./memory-review/config.js";
import { noteIndex, recentNotes, listTopics } from "./project-memory.js";

// Caps keep the managed block from ballooning as memory accumulates. They are
// configurable via ~/.omp/config.json (or project .omp/config.json).

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
  const total = noteIndex(cwd).length;
  const topics = listTopics(cwd);
  const config = readMemoryConfig(cwd);
  const lines: string[] = [START, "## oh-my-copilot project context"];
  if (goal) lines.push("", `**Repo goal:** ${goal}`);
  lines.push(
    "",
    "Project memory is available on demand:",
    "- `omp project-memory read` for project hints and the note index",
    "- `omp project-memory read <id>` for a specific note body",
    "- `omp daily-log read --days 7` for recent daily context",
  );
  if (total > 0) {
    // Surface the most recent note titles (newest-first, capped) so the next
    // session knows WHAT it remembers, not just that N notes exist. Bodies stay
    // on demand via `omp project-memory read <id>`.
    const shown: string[] = [];
    let chars = 0;
    for (const n of recentNotes(cwd, config.memoryNoteTitleCap)) {
      if (chars + n.title.length > config.memoryNoteCharCap) break;
      shown.push(`- ${n.title} (\`${n.id}\`)`);
      chars += n.title.length;
    }
    const more = total - shown.length;
    lines.push("", `Project memory notes (${total}):`, ...shown);
    if (more > 0) lines.push(`- (+${more} more — \`omp project-memory read\` for the full index)`);
  }

  // Surface topic pointers (id + one-liner description) capped to avoid bloat.
  // Descriptions stay brief; full bodies never appear inline.
  if (topics.length > 0) {
    const shownTopics: string[] = [];
    let topicChars = 0;
    for (const topic of topics) {
      // Truncate description to keep it brief
      const desc = topic.description.length > 60
        ? topic.description.slice(0, 57) + "…"
        : topic.description;
      const line = `- ${desc} (\`${topic.id}\`)`;
      if (topicChars + line.length > config.memoryTopicCharCap || shownTopics.length >= config.memoryTopicCap) {
        break;
      }
      shownTopics.push(line);
      topicChars += line.length;
    }
    const moreTopics = topics.length - shownTopics.length;
    lines.push("", `Project topics (${topics.length}):`, ...shownTopics);
    if (moreTopics > 0) lines.push(`- (+${moreTopics} more — \`omp project-memory topics\` for full list)`);
  }

  // Active handoffs: pointers only (id + sanitized one-line objective). Full
  // bodies load on demand via `omp handoff read <id>` — never inject packet bodies.
  const handoffs = listHandoffPointers(cwd);
  if (handoffs.length > 0) {
    const shown = handoffs.slice(0, 5).map((p) => {
      const clean = sanitizeForInstructions(p.objective);
      const obj = clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
      // Ids are already validated; still avoid backticks inside the objective.
      return `- ${obj.replace(/`/g, "'")} (\`${p.id}\`)`;
    });
    const more = handoffs.length - shown.length;
    lines.push(
      "",
      `Active handoffs (${handoffs.length}) — \`omp handoff read <id>\` to load:`,
      ...shown,
    );
    if (more > 0) lines.push(`- (+${more} more — \`omp handoff list\`)`);
  }

  lines.push(END);
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
