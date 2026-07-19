import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

/**
 * Must-follow directives from .omp/project-memory.json. These are injected at
 * SessionStart unconditionally — rules are never relevance-gated, so the agent
 * cannot skip them. (Notes stay on-demand; only directives are pushed.)
 * Marker sentinels are stripped and newlines collapsed at read time so legacy
 * rules written before storage-time sanitization can't smuggle instruction
 * structure into the injected block. Best-effort, never throws.
 */
export function readDirectives(directory) {
  try {
    const p = join(ompRoot(directory), ".omp", "project-memory.json");
    if (!existsSync(p)) return [];
    const data = JSON.parse(readFileSync(p, "utf8"));
    const list = Array.isArray(data?.directives) ? data.directives : [];
    return list
      .filter((d) => typeof d === "string" && d.trim() !== "")
      .map((d) =>
        d
          .replace(/<!--\s*omp:memory:(?:start|end)\s*-->/gi, "")
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      )
      .filter((d) => d !== "");
  } catch {
    return [];
  }
}
