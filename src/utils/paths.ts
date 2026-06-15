import { join } from "node:path";
import { ompRoot } from "../omp-root.js";

/**
 * Construct a path within the project's .omp directory.
 * @param cwd - The current working directory (project root)
 * @param segments - Additional path segments to join
 * @returns Absolute path to .omp/<segments>
 */
export function ompPath(cwd: string, ...segments: string[]): string {
  return join(ompRoot(cwd), ".omp", ...segments);
}

/**
 * Construct a path within the project's .omp/state directory.
 * @param cwd - The current working directory (project root)
 * @param segments - Additional path segments to join
 * @returns Absolute path to .omp/state/<segments>
 */
export function statePath(cwd: string, ...segments: string[]): string {
  return join(ompRoot(cwd), ".omp", "state", ...segments);
}
