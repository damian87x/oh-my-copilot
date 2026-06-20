import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { addNote } from "../project-memory.js";
import type { ReviewResult } from "./prompt.js";

// What the review may write, ordered by blast radius:
//  - notes  -> project memory (progressive disclosure, on-demand) — safe, applied.
//  - skill drafts -> .oh-my-copilot/self-evolve/drafts/<slug>/ — NEVER .github/skills,
//    so they are never auto-loaded; a human promotes them (matches /self-evolve).
//  - directives -> a pending review queue, NEVER auto-applied. Directives inject
//    into every future session, so an injected one would steer everything; they
//    stay gated behind explicit human review.

export interface ApplySummary {
  notesAdded: number;
  draftsWritten: string[];
  directivesQueued: number;
}

function reviewDir(cwd: string): string {
  return join(ompRoot(cwd), ".oh-my-copilot", "memory-review");
}

function draftsDir(cwd: string): string {
  return join(ompRoot(cwd), ".oh-my-copilot", "self-evolve", "drafts");
}

function writeAtomic(p: string, content: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

const GITIGNORE_START = "# omp:memory-review:start";
const GITIGNORE_END = "# omp:memory-review:end";

// Memory-mode writes notes/drafts/pending that may contain sensitive tool output,
// so ensure the project gitignores them before the first write. Idempotent and
// marker-guarded: append the managed block only if absent; never clobber user
// content. Best-effort — a gitignore failure must not block the review.
function ensureGitignored(cwd: string): void {
  try {
    const p = join(ompRoot(cwd), ".gitignore");
    const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (existing.includes(GITIGNORE_START)) return; // already managed
    const block = [GITIGNORE_START, ".omp/", ".oh-my-copilot/", GITIGNORE_END, ""].join("\n");
    const next = existing.trim() === "" ? `${block}` : `${existing.trimEnd()}\n\n${block}`;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

export function applyReview(cwd: string, result: ReviewResult): ApplySummary {
  ensureGitignored(cwd);
  let notesAdded = 0;
  for (const n of result.notes) {
    addNote(cwd, n.title, n.body);
    notesAdded += 1;
  }

  const draftsWritten: string[] = [];
  for (const d of result.skill_drafts) {
    if (!d.slug) continue;
    const skillMd = [
      "---",
      `name: learned-${d.slug}`,
      `description: ${JSON.stringify(d.reason || `Learned procedure: ${d.slug}`)}`,
      "status: draft",
      "---",
      "",
      d.body.trim() || `# ${d.slug}\n\n${d.reason}`,
      "",
    ].join("\n");
    writeAtomic(join(draftsDir(cwd), d.slug, "SKILL.md"), skillMd);
    draftsWritten.push(d.slug);
  }

  let directivesQueued = 0;
  if (result.directives.length > 0) {
    const pending = join(reviewDir(cwd), "pending-directives.md");
    const header = "# Pending directives (review before applying)\n";
    const existing = existsSync(pending) ? readFileSync(pending, "utf8") : header;
    const lines = result.directives.map((d) => `- [ ] ${d}`).join("\n");
    writeAtomic(pending, `${existing.trimEnd()}\n${lines}\n`);
    directivesQueued = result.directives.length;
  }

  return { notesAdded, draftsWritten, directivesQueued };
}
