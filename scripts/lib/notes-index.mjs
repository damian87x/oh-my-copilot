import { existsSync, readdirSync, readSync, openSync, closeSync, fstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Cheap notes index for the SessionStart breadcrumb: count + newest titles
// only. Mirrors the progressive-disclosure model (src/project-memory.ts) —
// titles are surfaced, bodies stay on disk and load on demand. Bounded I/O:
// the count comes from readdir; every entry gets a cheap stat for ordering,
// but only the newest few files are opened, and only a small prefix of each
// is read — a large note store can't stall the 5s startup hook. Titles are
// sanitized at read time (markers stripped, newlines collapsed) because
// legacy notes predate storage-time sanitization. Best-effort, never throws.

const MAX_TITLE_CHARS = 60;
const TITLE_PREFIX_BYTES = 4096;

function readTitlePrefix(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, TITLE_PREFIX_BYTES);
    if (size === 0) return "";
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

function sanitizeTitle(value) {
  return String(value)
    .replace(/<!--\s*omp:memory:(?:start|end)\s*-->/gi, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

export function notesSummary(directory, maxTitles = 3) {
  try {
    const dir = join(ompRoot(directory), ".omp", "memory", "notes");
    if (!existsSync(dir)) return { total: 0, titles: [] };
    const entries = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      try {
        const st = statSync(full); // follows symlinks: only real files count
        if (!st.isFile()) continue;
        entries.push({ full, id: f.replace(/\.md$/, ""), mtime: st.mtimeMs });
      } catch {
        // unreadable — skip
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
    const titles = [];
    for (const e of entries.slice(0, maxTitles)) {
      const first = readTitlePrefix(e.full).split("\n")[0] ?? "";
      const title = sanitizeTitle(first.replace(/^#\s*/, "")) || e.id;
      titles.push(title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title);
    }
    return { total: entries.length, titles };
  } catch {
    return { total: 0, titles: [] };
  }
}
