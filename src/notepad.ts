import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Scratch notepad at .omp/notepad.md with priority/working/manual sections.
// Exposed via the `omp notepad` CLI subcommands (NOT MCP).

export type Section = "priority" | "working" | "manual";
const SECTION_HEADERS: Record<Section, string> = {
  priority: "## priority",
  working: "## working",
  manual: "## manual",
};

function notepadPath(cwd: string): string {
  return join(resolve(cwd), ".omp", "notepad.md");
}

function readRaw(cwd: string): string {
  const p = notepadPath(cwd);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function writeRaw(cwd: string, content: string): void {
  const p = notepadPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

function parseSections(text: string): Record<Section, string> {
  const out: Record<Section, string> = { priority: "", working: "", manual: "" };
  let current: Section | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^##\s+(priority|working|manual)\s*$/);
    if (match) {
      current = match[1] as Section;
      continue;
    }
    if (current) out[current] += `${line}\n`;
  }
  for (const k of Object.keys(out) as Section[]) out[k] = out[k].replace(/\n+$/, "");
  return out;
}

function serializeSections(sections: Record<Section, string>): string {
  return (
    (["priority", "working", "manual"] as Section[])
      .map((s) => `${SECTION_HEADERS[s]}\n${sections[s]}`)
      .join("\n\n")
      .replace(/\n+$/, "") + "\n"
  );
}

/** Read the whole notepad, or one section. */
export function notepadRead(cwd: string, section: "all" | Section = "all"): string {
  const full = readRaw(cwd);
  if (section === "all") return full;
  return parseSections(full)[section] ?? "";
}

/** Replace a single section's text. */
export function notepadWrite(cwd: string, section: Section, text: string): void {
  const sections = parseSections(readRaw(cwd));
  sections[section] = text;
  writeRaw(cwd, serializeSections(sections));
}

/** Clear all sections. */
export function notepadPrune(cwd: string): void {
  writeRaw(cwd, serializeSections({ priority: "", working: "", manual: "" }));
}

export function notepadStats(
  cwd: string,
): { exists: boolean; bytes?: number; lineCount?: number; mtime?: string } {
  const p = notepadPath(cwd);
  if (!existsSync(p)) return { exists: false };
  const stats = statSync(p);
  const text = readFileSync(p, "utf8");
  return { exists: true, bytes: stats.size, lineCount: text.split("\n").length, mtime: stats.mtime.toISOString() };
}
