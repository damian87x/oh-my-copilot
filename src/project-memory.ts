import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.js";

// Durable per-project memory (notes + directives) at .omp/project-memory.json.
// Exposed via the `omp project-memory` CLI subcommands (NOT MCP).

export interface ProjectMemory {
  notes: string[];
  directives: string[];
  updatedAt: string;
}

function memPath(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "project-memory.json");
}

export function readProjectMemory(cwd: string): ProjectMemory {
  const p = memPath(cwd);
  if (!existsSync(p)) return { notes: [], directives: [], updatedAt: new Date(0).toISOString() };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectMemory;
  } catch {
    return { notes: [], directives: [], updatedAt: new Date(0).toISOString() };
  }
}

function writeProjectMemory(cwd: string, memory: ProjectMemory): void {
  const p = memPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ ...memory, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  renameSync(tmp, p);
}

/** Append a single note; returns the new note count. */
export function addProjectNote(cwd: string, note: string): number {
  const memory = readProjectMemory(cwd);
  memory.notes.push(String(note));
  writeProjectMemory(cwd, memory);
  return memory.notes.length;
}

/** Append a single directive; returns the new directive count. */
export function addProjectDirective(cwd: string, directive: string): number {
  const memory = readProjectMemory(cwd);
  memory.directives.push(String(directive));
  writeProjectMemory(cwd, memory);
  return memory.directives.length;
}
