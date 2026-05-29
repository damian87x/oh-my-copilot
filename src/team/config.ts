import { existsSync, readFileSync } from "node:fs";
import type { TeamStatePaths } from "./state-paths.js";
import type { TeamConfig } from "./types.js";

/**
 * Read a team's config.json. Pure leaf read (no orchestration dependency) so
 * both the runtime and the api layer can import it without a cycle.
 */
export function loadTeamConfig(paths: TeamStatePaths): TeamConfig | undefined {
  if (!existsSync(paths.configFile)) return undefined;
  try {
    return JSON.parse(readFileSync(paths.configFile, "utf8")) as TeamConfig;
  } catch {
    return undefined;
  }
}
