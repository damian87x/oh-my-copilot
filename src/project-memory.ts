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

// --- topics (surfaced in instructions-memory) ---

export interface Topic {
  id: string;
  description: string; // one-liner, extracted from note title
}

/**
 * List all topics (id + one-liner description) sorted by id.
 * Descriptions are extracted from note titles.
 */
export function listTopics(cwd: string): Topic[] {
  return noteIndex(cwd).map(({ id, title }) => ({
    id,
    description: title,
  }));
}

// --- topics (topic-based durable memory with fact consolidation) ---

export interface TopicMemory {
  id: string;
  topic: string;
  lastUpdated: string;
  facts: string[];
}

interface TopicFile {
  topic: string;
  lastUpdated: string;
  facts: string[];
}

function topicsDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "memory", "topics");
}

function isValidTopicId(id: string): boolean {
  return /^[a-z0-9-]+$/i.test(id) && id.length > 0 && id.length <= 100;
}

function topicPath(cwd: string, topic: string): string {
  return join(topicsDir(cwd), `${topic}.json`);
}

/** Read topic memory from disk; returns empty topic if missing. */
export function readTopicMemory(cwd: string, topic: string): TopicMemory | null {
  if (!isValidTopicId(topic)) return null;
  const p = topicPath(cwd, topic);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as TopicFile;
    return {
      id: topic,
      topic: data.topic,
      lastUpdated: data.lastUpdated,
      facts: Array.isArray(data.facts) ? data.facts : [],
    };
  } catch {
    return null;
  }
}

function writeTopicMemory(cwd: string, topic: string, data: TopicFile): void {
  const p = topicPath(cwd, topic);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, p);
}

/** Add a single fact to a topic; creates topic if missing. Returns true if fact was added. */
export function addTopicFact(cwd: string, topic: string, fact: string): boolean {
  if (!isValidTopicId(topic)) return false;
  const memo = readTopicMemory(cwd, topic) || {
    id: topic,
    topic,
    lastUpdated: new Date().toISOString(),
    facts: [],
  };
  const trimmedFact = String(fact).trim();
  if (!trimmedFact) return false;
  if (memo.facts.includes(trimmedFact)) return false; // duplicate
  memo.facts.push(trimmedFact);
  writeTopicMemory(cwd, topic, {
    topic: memo.topic,
    lastUpdated: new Date().toISOString(),
    facts: memo.facts,
  });
  return true;
}

/** List all topic memories; returns array of topic ids. */
export function listTopicMemories(cwd: string): string[] {
  const dir = topicsDir(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** Remove a fact by index from a topic; returns true if removed. */
export function removeTopicFact(cwd: string, topic: string, factIndex: number): boolean {
  if (!isValidTopicId(topic)) return false;
  const memo = readTopicMemory(cwd, topic);
  if (!memo) return false;
  if (factIndex < 0 || factIndex >= memo.facts.length) return false;
  memo.facts.splice(factIndex, 1);
  writeTopicMemory(cwd, topic, {
    topic: memo.topic,
    lastUpdated: new Date().toISOString(),
    facts: memo.facts,
  });
  return true;
}

export interface ConsolidationSummary {
  merged: number;
  removed: number;
  kept: number;
}

/** Consolidate topic facts by replacing current facts with a merged list.
 *  Returns a summary of merged/removed/kept facts. */
export function consolidateTopicFacts(
  cwd: string,
  topic: string,
  consolidatedFacts: string[],
): ConsolidationSummary | null {
  if (!isValidTopicId(topic)) return null;
  const memo = readTopicMemory(cwd, topic);
  if (!memo) return null;
  const oldCount = memo.facts.length;
  const filtered = consolidatedFacts.map((f) => String(f).trim()).filter((f) => f.length > 0);
  const newCount = filtered.length;
  const kept = memo.facts.filter((f) => filtered.includes(f)).length;
  memo.facts = filtered;
  writeTopicMemory(cwd, topic, {
    topic: memo.topic,
    lastUpdated: new Date().toISOString(),
    facts: memo.facts,
  });
  return {
    merged: oldCount - kept,
    removed: oldCount - newCount,
    kept,
  };
}

export interface PromotionSummary {
  promotedCount: number;
  targetTopic: string;
}

/** Promote facts from one topic to another (or new topic).
 *  Removes promoted facts from source and adds to target.
 *  Returns summary of promoted facts. */
export function promoteToDurableMemory(
  cwd: string,
  sourceId: string,
  targetTopic: string,
  facts: string[],
): PromotionSummary | null {
  if (!isValidTopicId(sourceId) || !isValidTopicId(targetTopic)) return null;
  const source = readTopicMemory(cwd, sourceId);
  if (!source) return null;

  // Add facts to target
  let promotedCount = 0;
  for (const fact of facts) {
    const trimmed = String(fact).trim();
    if (trimmed && addTopicFact(cwd, targetTopic, trimmed)) {
      promotedCount += 1;
    }
  }

  // Remove promoted facts from source
  for (const fact of facts) {
    const trimmed = String(fact).trim();
    const idx = source.facts.indexOf(trimmed);
    if (idx >= 0) {
      removeTopicFact(cwd, sourceId, idx);
      // Re-read since removal changes indices
      const updated = readTopicMemory(cwd, sourceId);
      if (updated) source.facts = updated.facts;
    }
  }

  return { promotedCount, targetTopic };
}
