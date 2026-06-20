import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// Durable project memory, split by how it's surfaced:
//  - directives (rules)  -> .omp/project-memory.json, injected every session
//  - notes (facts)       -> .omp/memory/notes/<id>.md, progressive disclosure:
//    an index (id + title) is cheap to surface; a note's body loads on demand
//    by id — like skills (frontmatter index + body-on-invoke), so notes never
//    bloat context no matter how many accumulate.

interface ProjectMemory {
  directives: string[];
  updatedAt: string;
}

function memPath(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "project-memory.json");
}

function notesDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "memory", "notes");
}

// --- directives (rules, injected at session start) ---

function readMem(cwd: string): ProjectMemory {
  const p = memPath(cwd);
  if (!existsSync(p)) return { directives: [], updatedAt: new Date(0).toISOString() };
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return {
      directives: Array.isArray(data?.directives) ? data.directives : [],
      updatedAt: typeof data?.updatedAt === "string" ? data.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { directives: [], updatedAt: new Date(0).toISOString() };
  }
}

function writeMem(cwd: string, mem: ProjectMemory): void {
  const p = memPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ directives: mem.directives, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  renameSync(tmp, p);
}

export function readDirectives(cwd: string): string[] {
  return readMem(cwd).directives;
}

/** Append a must-follow directive; returns the new directive count. */
export function addDirective(cwd: string, directive: string): number {
  const mem = readMem(cwd);
  mem.directives.push(String(directive).trim());
  writeMem(cwd, mem);
  return mem.directives.length;
}

// --- notes (facts, progressive disclosure) ---

export interface NoteMeta {
  id: string;
  title: string;
}

function slugify(title: string): string {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "note"
  );
}

/** Create a note (title + optional body); returns its id (slug, deduped). */
export function addNote(cwd: string, title: string, body?: string): string {
  const dir = notesDir(cwd);
  mkdirSync(dir, { recursive: true });
  const base = slugify(title);
  let id = base;
  let n = 1;
  while (existsSync(join(dir, `${id}.md`))) {
    n += 1;
    id = `${base}-${n}`;
  }
  const content = `# ${String(title).trim()}\n${body ? `\n${String(body).trim()}\n` : ""}`;
  const p = join(dir, `${id}.md`);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
  return id;
}

/** Cheap index of (id, title) — the only thing surfaced; bodies stay on disk. */
export function noteIndex(cwd: string): NoteMeta[] {
  const dir = notesDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const id = f.replace(/\.md$/, "");
      let title = id;
      try {
        const first = readFileSync(join(dir, f), "utf8").split("\n")[0] ?? "";
        title = first.replace(/^#\s*/, "").trim() || id;
      } catch {
        // keep id as title
      }
      return { id, title };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Notes ordered newest-first by mtime, optionally capped. Used to surface the
 *  most recent titles in the injected block without unbounded growth. */
export function recentNotes(cwd: string, limit?: number): NoteMeta[] {
  const dir = notesDir(cwd);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const id = f.replace(/\.md$/, "");
      let title = id;
      let mtime = 0;
      try {
        const full = join(dir, f);
        mtime = statSync(full).mtimeMs;
        const first = readFileSync(full, "utf8").split("\n")[0] ?? "";
        title = first.replace(/^#\s*/, "").trim() || id;
      } catch {
        // keep defaults
      }
      return { id, title, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const capped = typeof limit === "number" ? entries.slice(0, limit) : entries;
  return capped.map(({ id, title }) => ({ id, title }));
}

/** Prune notes by count (keep N newest) and/or age (older than N days).
 *  Returns the ids removed. No options → no-op (never deletes silently). */
export function pruneNotes(
  cwd: string,
  opts: { keep?: number; olderThanDays?: number },
): string[] {
  const dir = notesDir(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      let mtime = 0;
      try {
        mtime = statSync(join(dir, f)).mtimeMs;
      } catch {
        // unreadable — treat as oldest so it's eligible for pruning
      }
      return { id: f.replace(/\.md$/, ""), file: f, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest-first

  const toRemove = new Set<string>();
  if (typeof opts.keep === "number" && opts.keep >= 0) {
    for (const e of files.slice(opts.keep)) toRemove.add(e.file);
  }
  if (typeof opts.olderThanDays === "number" && opts.olderThanDays >= 0) {
    const cutoff = Date.now() - opts.olderThanDays * 86400_000;
    for (const e of files) if (e.mtime < cutoff) toRemove.add(e.file);
  }

  const removed: string[] = [];
  for (const e of files) {
    if (!toRemove.has(e.file)) continue;
    try {
      unlinkSync(join(dir, e.file));
      removed.push(e.id);
    } catch {
      // skip files we can't remove
    }
  }
  return removed.sort();
}

/** Full note body by id, or null when missing. */
export function readNote(cwd: string, id: string): string | null {
  // Ids are slugs ([a-z0-9-]); reject anything else so a crafted id can't
  // escape the notes dir via path traversal (e.g. "../../README").
  if (!/^[a-z0-9-]+$/i.test(id)) return null;
  const p = join(notesDir(cwd), `${id}.md`);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}
