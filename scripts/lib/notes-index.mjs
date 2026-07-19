import { readdirSync, readSync, openSync, closeSync, fstatSync, statSync } from "node:fs";
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
//
// TOCTOU posture: the stat that selects a file records dev+ino; the read then
// goes through ONE descriptor whose fstat must match that identity (and still
// be a regular file) before any byte is read. A path swapped between select
// and read (symlink planted, file replaced) fails the identity check and is
// skipped — we never display bytes from a file we didn't measure.

const MAX_TITLE_CHARS = 60;
const TITLE_PREFIX_BYTES = 4096;

/** Read up to TITLE_PREFIX_BYTES of the file identified by `expected`
 *  ({dev, ino} from the selection stat); null when the opened file is not
 *  exactly that regular file. Everything happens through one descriptor. */
function readTitlePrefix(path, expected) {
  let fd;
  try {
    fd = openSync(path, "r");
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) return null;
    const size = Math.min(st.size, TITLE_PREFIX_BYTES);
    if (size === 0) return "";
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } catch {
    return null;
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
    let names;
    try {
      names = readdirSync(dir); // one call — no existsSync pre-check to race
    } catch {
      return { total: 0, titles: [] }; // missing/unreadable dir = no notes
    }
    const entries = [];
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      try {
        const st = statSync(full); // follows symlinks: only real files count
        if (!st.isFile()) continue;
        entries.push({ full, id: f.replace(/\.md$/, ""), mtime: st.mtimeMs, dev: st.dev, ino: st.ino });
      } catch {
        // unreadable — skip
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
    const titles = [];
    for (const e of entries) {
      if (titles.length >= maxTitles) break;
      const prefix = readTitlePrefix(e.full, e);
      if (prefix === null) continue; // swapped between select and read — skip
      const first = prefix.split("\n")[0] ?? "";
      const title = sanitizeTitle(first.replace(/^#\s*/, "")) || e.id;
      titles.push(title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title);
    }
    return { total: entries.length, titles };
  } catch {
    return { total: 0, titles: [] };
  }
}
