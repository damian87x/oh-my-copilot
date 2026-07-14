import { join } from "node:path";
import { ompPath } from "../utils/paths.js";

/** `.omp/handoffs` under the project root. */
export function handoffsDir(cwd: string): string {
  return ompPath(cwd, "handoffs");
}

/** Active-index file (active handoffs only). */
export function handoffIndexPath(cwd: string): string {
  return join(handoffsDir(cwd), "index.json");
}

/**
 * Path to a single handoff artifact.
 * Callers MUST validate `id` with `assertValidHandoffId` first.
 */
export function handoffFilePath(cwd: string, id: string): string {
  return join(handoffsDir(cwd), `${id}.json`);
}
