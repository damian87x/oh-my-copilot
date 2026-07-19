import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Standalone .mjs mirror of the render caps in src/memory-review/config.ts —
// hooks can't import the TS CLI, so the directive injection budget is read
// here. Same precedence: project .omp/config.json over global ~/.omp/config.json
// over defaults, per key. Best-effort, never throws.

export const DEFAULT_DIRECTIVE_CAP = 12;
export const DEFAULT_DIRECTIVE_CHAR_CAP = 1200;

function readRawAt(p) {
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** Injection budget for must-follow directives at SessionStart. */
export function readDirectiveCaps(directory) {
  try {
    const home = process.env.OMP_HOME_OVERRIDE || homedir();
    const raw = {
      ...readRawAt(join(home, ".omp", "config.json")),
      ...readRawAt(join(ompRoot(directory), ".omp", "config.json")),
    };
    return {
      directiveCap: positiveInt(raw.memoryDirectiveCap, DEFAULT_DIRECTIVE_CAP),
      directiveCharCap: positiveInt(raw.memoryDirectiveCharCap, DEFAULT_DIRECTIVE_CHAR_CAP),
    };
  } catch {
    return { directiveCap: DEFAULT_DIRECTIVE_CAP, directiveCharCap: DEFAULT_DIRECTIVE_CHAR_CAP };
  }
}
