import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

type Section = "priority" | "working" | "manual";
const SECTION_HEADERS: Record<Section, string> = {
  priority: "## priority",
  working: "## working",
  manual: "## manual",
};

function notepadPath(cwd: string): string {
  return join(resolve(cwd), ".omp", "notepad.md");
}

function readNotepad(cwd: string): string {
  const p = notepadPath(cwd);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function writeNotepad(cwd: string, content: string): void {
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
  return (["priority", "working", "manual"] as Section[])
    .map((s) => `${SECTION_HEADERS[s]}\n${sections[s]}`)
    .join("\n\n")
    .replace(/\n+$/, "") + "\n";
}

function writeSection(cwd: string, section: Section, text: string): void {
  const sections = parseSections(readNotepad(cwd));
  sections[section] = text;
  writeNotepad(cwd, serializeSections(sections));
}

export const notepadTools: ToolDefinition[] = [
  {
    name: "notepad_read",
    category: "notepad",
    description: "Read all or one section of .omp/notepad.md.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["all", "priority", "working", "manual"] as const },
        cwd: { type: "string" },
      },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const section = (args.section as string) ?? "all";
      const full = readNotepad(cwd);
      if (section === "all") return textResult(full);
      const parsed = parseSections(full);
      return textResult(parsed[section as Section] ?? "");
    },
  },
  {
    name: "notepad_write_priority",
    category: "notepad",
    description: "Replace the 'priority' section.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, cwd: { type: "string" } }, required: ["text"] },
    handler: (args) => {
      writeSection((args.cwd as string) ?? process.cwd(), "priority", String(args.text ?? ""));
      return jsonResult({ ok: true });
    },
  },
  {
    name: "notepad_write_working",
    category: "notepad",
    description: "Replace the 'working' section.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, cwd: { type: "string" } }, required: ["text"] },
    handler: (args) => {
      writeSection((args.cwd as string) ?? process.cwd(), "working", String(args.text ?? ""));
      return jsonResult({ ok: true });
    },
  },
  {
    name: "notepad_write_manual",
    category: "notepad",
    description: "Replace the 'manual' section.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, cwd: { type: "string" } }, required: ["text"] },
    handler: (args) => {
      writeSection((args.cwd as string) ?? process.cwd(), "manual", String(args.text ?? ""));
      return jsonResult({ ok: true });
    },
  },
  {
    name: "notepad_prune",
    category: "notepad",
    description: "Clear all sections of the notepad.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => {
      writeNotepad((args.cwd as string) ?? process.cwd(), serializeSections({ priority: "", working: "", manual: "" }));
      return jsonResult({ ok: true });
    },
  },
  {
    name: "notepad_stats",
    category: "notepad",
    description: "Return byte count + line count + last-modified for the notepad.",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const p = notepadPath(cwd);
      if (!existsSync(p)) return jsonResult({ exists: false });
      const stats = statSync(p);
      const text = readFileSync(p, "utf8");
      return jsonResult({
        exists: true,
        bytes: stats.size,
        lineCount: text.split("\n").length,
        mtime: stats.mtime.toISOString(),
      });
    },
  },
];
