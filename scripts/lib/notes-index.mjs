import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Cheap notes index for the SessionStart breadcrumb: count + newest titles
// only. Mirrors the progressive-disclosure model (src/project-memory.ts) —
// titles are surfaced, bodies stay on disk and load on demand. Best-effort,
// never throws.

const MAX_TITLE_CHARS = 60;

export function notesSummary(directory, maxTitles = 3) {
  try {
    const dir = join(ompRoot(directory), ".omp", "memory", "notes");
    if (!existsSync(dir)) return { total: 0, titles: [] };
    const entries = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      let mtime = 0;
      let title = f.replace(/\.md$/, "");
      try {
        mtime = statSync(full).mtimeMs;
        const first = readFileSync(full, "utf8").split("\n")[0] ?? "";
        title = first.replace(/^#\s*/, "").trim() || title;
      } catch {
        // unreadable file — keep id as title, mtime 0 (sorts oldest)
      }
      entries.push({ title, mtime });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    const titles = entries
      .slice(0, maxTitles)
      .map((e) => (e.title.length > MAX_TITLE_CHARS ? `${e.title.slice(0, MAX_TITLE_CHARS - 1)}…` : e.title));
    return { total: entries.length, titles };
  } catch {
    return { total: 0, titles: [] };
  }
}
