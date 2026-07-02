import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { addNote, noteIndex, readDirectives, readNote } from "../project-memory.js";
import type { ReviewResult } from "./prompt.js";
import { draftsDir, migrateLegacyQuarantine, pendingDirectiveTexts, reviewDir } from "./quarantine.js";

// What the review may write, ordered by blast radius:
//  - notes  -> project memory (progressive disclosure, on-demand) — safe, applied.
//  - skill drafts -> .omp/self-evolve/drafts/<slug>/ — NEVER .github/skills,
//    so they are never auto-loaded; a human promotes them (matches /self-evolve).
//  - directives -> a pending review queue, NEVER auto-applied. Directives inject
//    into every future session, so an injected one would steer everything; they
//    stay gated behind explicit human review.

export interface ApplySummary {
  notesAdded: number;
  draftsWritten: string[];
  directivesQueued: number;
  notesSkipped: number;
  draftsSkipped: number;
  directivesSkipped: number;
}

// Dedup: automated runs happen every session, so anything already captured —
// an identical note, a known skill slug (draft or promoted), an active or
// already-proposed directive — must be skipped, not re-written.

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

function skillSlugKnown(cwd: string, slug: string): boolean {
  const skillsRoot = join(ompRoot(cwd), ".github", "skills");
  return (
    existsSync(join(draftsDir(cwd), slug, "SKILL.md")) ||
    existsSync(join(skillsRoot, slug)) ||
    existsSync(join(skillsRoot, `learned-${slug}`))
  );
}

function noteIsDuplicate(cwd: string, title: string, body: string): boolean {
  const t = title.trim();
  // readNote returns trimmed content, so compare against the trimmed render
  const rendered = `# ${t}\n${body.trim() ? `\n${body.trim()}\n` : ""}`.trim();
  return noteIndex(cwd).some((meta) => meta.title === t && readNote(cwd, meta.id) === rendered);
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
  migrateLegacyQuarantine(cwd);
  let notesAdded = 0;
  let notesSkipped = 0;
  for (const n of result.notes) {
    if (noteIsDuplicate(cwd, n.title, n.body)) {
      notesSkipped += 1;
      continue;
    }
    addNote(cwd, n.title, n.body);
    notesAdded += 1;
  }

  const draftsWritten: string[] = [];
  let draftsSkipped = 0;
  for (const d of result.skill_drafts) {
    if (!d.slug) continue;
    if (skillSlugKnown(cwd, d.slug)) {
      draftsSkipped += 1;
      continue;
    }
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
  let directivesSkipped = 0;
  if (result.directives.length > 0) {
    const known = new Set([...readDirectives(cwd), ...pendingDirectiveTexts(cwd)].map(normalize));
    const fresh = result.directives.filter((d) => !known.has(normalize(d)));
    directivesSkipped = result.directives.length - fresh.length;
    if (fresh.length > 0) {
      const pending = join(reviewDir(cwd), "pending-directives.md");
      const header = "# Pending directives (review before applying)\n";
      const existing = existsSync(pending) ? readFileSync(pending, "utf8") : header;
      const lines = fresh.map((d) => `- [ ] ${d}`).join("\n");
      writeAtomic(pending, `${existing.trimEnd()}\n${lines}\n`);
      directivesQueued = fresh.length;
    }
  }

  return { notesAdded, draftsWritten, directivesQueued, notesSkipped, draftsSkipped, directivesSkipped };
}
