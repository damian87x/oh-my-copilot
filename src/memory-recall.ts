import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.js";
import { readNote, noteIndex } from "./project-memory.js";

export interface MemoryResult {
  source: "topic" | "note" | "daily-log";
  id: string;
  title: string;
  preview: string;
}

export interface SearchOptions {
  query: string;
  topic?: string;
  dateRange?: { start: Date; end: Date };
  keyword?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;

function extractPreview(text: string, maxLen = 200): string {
  const lines = text.split("\n");
  let preview = "";
  for (const line of lines) {
    if (preview.length + line.length <= maxLen) {
      preview += (preview ? " " : "") + line.trim();
    } else {
      break;
    }
  }
  return preview || text.slice(0, maxLen);
}

function searchInText(text: string, searchTerms: string[]): boolean {
  const lower = text.toLowerCase();
  return searchTerms.every((term) => lower.includes(term.toLowerCase()));
}

function getNotesResults(
  cwd: string,
  searchTerms: string[],
  keyword?: string,
  limit?: number,
): MemoryResult[] {
  const results: MemoryResult[] = [];
  const notes = noteIndex(cwd);

  for (const note of notes) {
    if (limit && results.length >= limit) break;

    const body = readNote(cwd, note.id);
    if (!body) continue;

    const fullText = `${note.title}\n${body}`;
    if (!searchInText(fullText, searchTerms)) continue;

    if (keyword && !searchInText(fullText, [keyword])) continue;

    const preview = extractPreview(body);
    results.push({
      source: "note",
      id: note.id,
      title: note.title,
      preview,
    });
  }

  return results;
}

function getDailyLogResults(
  cwd: string,
  searchTerms: string[],
  dateRange?: { start: Date; end: Date },
  keyword?: string,
  limit?: number,
): MemoryResult[] {
  const results: MemoryResult[] = [];
  const dailyDir = join(ompRoot(cwd), ".omp", "memory", "daily");

  if (!existsSync(dailyDir)) return [];

  const files = readdirSync(dailyDir)
    .filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();

  for (const file of files) {
    if (limit && results.length >= limit) break;

    const dateStr = file.replace(/\.md$/, "");
    const date = new Date(dateStr);

    if (dateRange) {
      if (date < dateRange.start || date > dateRange.end) continue;
    }

    const filePath = join(dailyDir, file);
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const fullText = `${dateStr}\n${content}`;
    if (!searchInText(fullText, searchTerms)) continue;

    if (keyword && !searchInText(fullText, [keyword])) continue;

    const preview = extractPreview(content);
    results.push({
      source: "daily-log",
      id: dateStr,
      title: `Daily log: ${dateStr}`,
      preview,
    });
  }

  return results;
}

/**
 * Search memory across topics, notes, and daily logs with bounded results.
 * Supports filtering by topic, date range, and keyword.
 * Returns type-safe results with source labels and preview text.
 *
 * @param cwd - Project root directory
 * @param options - Search options including query, filters, and result limit
 * @returns Array of memory results, bounded by limit (default 20)
 */
export function searchMemory(cwd: string, options: SearchOptions): MemoryResult[] {
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
  const query = (options.query || "").trim();

  if (!query) return [];

  const searchTerms = query.split(/\s+/).filter((t) => t);
  if (searchTerms.length === 0) return [];

  const results: MemoryResult[] = [];

  // Always include notes
  const notesResults = getNotesResults(cwd, searchTerms, options.keyword, limit - results.length);
  results.push(...notesResults);

  // Include daily logs
  if (results.length < limit) {
    const dailyResults = getDailyLogResults(
      cwd,
      searchTerms,
      options.dateRange,
      options.keyword,
      limit - results.length,
    );
    results.push(...dailyResults);
  }

  return results.slice(0, limit);
}
