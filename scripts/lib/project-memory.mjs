import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

/**
 * Must-follow directives from .omp/project-memory.json. These are injected at
 * SessionStart unconditionally — rules are never relevance-gated, so the agent
 * cannot skip them. (Notes stay on-demand; only directives are pushed.)
 * Best-effort, never throws.
 */
export function readDirectives(directory) {
  try {
    const p = join(ompRoot(directory), ".omp", "project-memory.json");
    if (!existsSync(p)) return [];
    const data = JSON.parse(readFileSync(p, "utf8"));
    const list = Array.isArray(data?.directives) ? data.directives : [];
    return list.filter((d) => typeof d === "string" && d.trim() !== "").map((d) => d.trim());
  } catch {
    return [];
  }
}
