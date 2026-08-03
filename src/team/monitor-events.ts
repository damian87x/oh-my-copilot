import { readFileSync } from "node:fs";
import { ompRoot } from "../omp-root.js";
import { atomicWrite } from "../utils/fs.js";
import {
  ensureTeamMonitorDirs,
  resolveTeamMonitorPaths,
} from "./state-paths.js";

export interface TeamMonitorEvent {
  schemaVersion: 1;
  type: string;
  timestamp: string;
  token?: string;
  message?: string;
  buildId?: string;
}

export function recordTeamMonitorEvent(
  cwd: string,
  event: Omit<TeamMonitorEvent, "schemaVersion" | "timestamp"> & {
    at?: number;
  },
  retainedEvents = 100,
): void {
  try {
    const paths = resolveTeamMonitorPaths(ompRoot(cwd));
    ensureTeamMonitorDirs(paths);
    const previous = (() => {
      try {
        return readFileSync(paths.eventsFile, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0);
      } catch {
        return [];
      }
    })();
    const next: TeamMonitorEvent = {
      schemaVersion: 1,
      type: event.type,
      timestamp: new Date(event.at ?? Date.now()).toISOString(),
      ...(event.token ? { token: event.token } : {}),
      ...(event.message ? { message: event.message } : {}),
      ...(event.buildId ? { buildId: event.buildId } : {}),
    };
    const lines = [
      ...previous,
      JSON.stringify(next),
    ].slice(-Math.max(1, retainedEvents));
    atomicWrite(paths.eventsFile, `${lines.join("\n")}\n`);
  } catch {
    // Diagnostic persistence must never break loop or team lifecycle commands.
  }
}
