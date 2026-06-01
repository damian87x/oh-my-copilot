import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Resolve the project root for .omp storage: walk up from `start` to the nearest
// project marker (.git, then package.json), so memory is scoped to the actual
// project even when omp is run from a nested directory or a parent workspace.
// Falls back to `start` when no marker is found. Used by every .omp path so the
// CLI and hooks agree on one location per project.
export function ompRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
