import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function readCursor(cursorPath) {
  if (!existsSync(cursorPath)) return 0;
  try {
    return Number(JSON.parse(readFileSync(cursorPath, "utf8")).bytesRead) || 0;
  } catch {
    return 0;
  }
}

function advanceCursor(cursorPath, bytes) {
  mkdirSync(dirname(cursorPath), { recursive: true });
  const tmp = `${cursorPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ bytesRead: bytes }), "utf8");
  renameSync(tmp, cursorPath);
}

/**
 * Scan unseen scheduled-run results across all jobs and return a banner string,
 * advancing each job's byte-offset cursor. Bounded by maxEntries (total) and
 * maxBytes (per file) so the SessionStart hook stays within its time budget.
 * Append-only: never rewrites the results JSONL — only advances cursors.
 */
export function scanScheduleResults(directory, opts = {}) {
  const maxEntries = opts.maxEntries ?? 10;
  const maxBytes = opts.maxBytes ?? 16_384;
  const resultsDir = join(directory, ".omp", "state", "schedule", "results");
  if (!existsSync(resultsDir)) return "";

  const lines = [];
  let budget = maxEntries;

  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (budget <= 0) break;
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(0, -".jsonl".length);
    const resultsPath = join(resultsDir, entry.name);
    const cursorPath = join(resultsDir, `${id}.offset`);

    let cursor = readCursor(cursorPath);
    const fd = openSync(resultsPath, "r");
    let buf;
    try {
      const size = fstatSync(fd).size;
      if (cursor > size) cursor = 0; // truncated/rotated → re-read from start
      if (cursor >= size) continue;

      const remaining = Math.min(size - cursor, maxBytes);
      buf = Buffer.alloc(remaining);
      readSync(fd, buf, 0, remaining, cursor);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) continue;

    const completeLines = text.slice(0, lastNewline + 1).split("\n").filter(Boolean);
    let consumedBytes = 0;
    for (const line of completeLines) {
      if (budget <= 0) break;
      consumedBytes += Buffer.byteLength(`${line}\n`, "utf8");
      budget -= 1;
      try {
        const r = JSON.parse(line);
        const summary = String(r.summary ?? "").slice(0, 100);
        lines.push(`- ${id} @ ${r.ts}: ${r.status} — ${summary}`);
      } catch {
        // skip unparseable line but still advance past it
      }
    }
    advanceCursor(cursorPath, cursor + consumedBytes);
  }

  return lines.length ? `[SCHEDULE RESULTS]\n${lines.join("\n")}` : "";
}
