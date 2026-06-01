import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Plain-Node mirror of src/omp-root.ts for the hooks: walk up from `start` to the
// nearest project marker (.git, then package.json) so memory is scoped to the
// real project, not the literal cwd. Falls back to `start` when none is found.
export function ompRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
