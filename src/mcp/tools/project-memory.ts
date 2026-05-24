import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jsonResult, type ToolDefinition } from "../types.js";

interface ProjectMemory {
  notes: string[];
  directives: string[];
  updatedAt: string;
}

function memPath(cwd: string): string {
  return join(resolve(cwd), ".omp", "project-memory.json");
}

function readMemory(cwd: string): ProjectMemory {
  const p = memPath(cwd);
  if (!existsSync(p)) return { notes: [], directives: [], updatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectMemory;
  } catch {
    return { notes: [], directives: [], updatedAt: new Date(0).toISOString() };
  }
}

function writeMemory(cwd: string, memory: ProjectMemory): void {
  const p = memPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ ...memory, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  renameSync(tmp, p);
}

export const projectMemoryTools: ToolDefinition[] = [
  {
    name: "project_memory_read",
    category: "project_memory",
    description: "Read .omp/project-memory.json (notes + directives).",
    inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    handler: (args) => jsonResult(readMemory((args.cwd as string) ?? process.cwd())),
  },
  {
    name: "project_memory_write",
    category: "project_memory",
    description: "Replace .omp/project-memory.json with the given notes + directives.",
    inputSchema: {
      type: "object",
      properties: {
        notes: { type: "array", items: { type: "string" } },
        directives: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const memory: ProjectMemory = {
        notes: (args.notes as string[] | undefined) ?? readMemory(cwd).notes,
        directives: (args.directives as string[] | undefined) ?? readMemory(cwd).directives,
        updatedAt: new Date().toISOString(),
      };
      writeMemory(cwd, memory);
      return jsonResult({ ok: true });
    },
  },
  {
    name: "project_memory_add_note",
    category: "project_memory",
    description: "Append a single note to project memory.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" }, cwd: { type: "string" } },
      required: ["note"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const memory = readMemory(cwd);
      memory.notes.push(String(args.note));
      writeMemory(cwd, memory);
      return jsonResult({ ok: true, count: memory.notes.length });
    },
  },
  {
    name: "project_memory_add_directive",
    category: "project_memory",
    description: "Append a single directive to project memory.",
    inputSchema: {
      type: "object",
      properties: { directive: { type: "string" }, cwd: { type: "string" } },
      required: ["directive"],
    },
    handler: (args) => {
      const cwd = (args.cwd as string) ?? process.cwd();
      const memory = readMemory(cwd);
      memory.directives.push(String(args.directive));
      writeMemory(cwd, memory);
      return jsonResult({ ok: true, count: memory.directives.length });
    },
  },
];
