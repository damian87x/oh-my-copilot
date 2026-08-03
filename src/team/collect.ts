import {
  closeSync,
  constants,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { openRegularFile } from "../utils/fs.js";
import { makeTmux, type TmuxApi } from "./tmux.js";

// Deterministic team report-back for the visual flow (oh-my-codex model): each
// worker is told to write its final result to <dir>/<laneId>.result.md, so
// "done" is an explicit file write — NOT a fragile scrape of the live pane
// (which either misses the busy window → stuck "working", or reads idle too
// early → false "done"). The lead polls `omp team collect --dir <dir>` until
// every lane has delivered, then synthesizes from the files.

export interface LaneSpec {
  id: string;
  name?: string;
  /** Optional tmux pane id, used only to flag a crashed worker as "dead". */
  paneId?: string;
}

export type LaneStatus = "done" | "working" | "dead";

export interface LaneResult {
  id: string;
  name?: string;
  status: LaneStatus;
  /** Delivered result file contents for done lanes; empty otherwise. */
  output: string;
}

export interface CollectResult {
  dir: string;
  lanes: LaneResult[];
  total: number;
  /** Terminal lanes (delivered or dead). */
  doneCount: number;
  allDone: boolean;
}

const LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PANE_ID_RE = /^%\d+$/;

function validLane(lane: unknown): lane is LaneSpec {
  if (!lane || typeof lane !== "object") return false;
  const value = lane as Record<string, unknown>;
  return (
    typeof value.id === "string" &&
    LANE_ID_RE.test(value.id) &&
    (value.name === undefined || typeof value.name === "string") &&
    (
      value.paneId === undefined ||
      (typeof value.paneId === "string" && PANE_ID_RE.test(value.paneId))
    )
  );
}

function readTrustedRegularFile(
  filePath: string,
  trustedRoot: string,
): string | undefined {
  const opened = openRegularFile(filePath, constants.O_RDONLY, {
    rejectHardlinks: true,
    trustedRoot,
  });
  if (!opened.ok) return undefined;
  try {
    try {
      return readFileSync(opened.fd, "utf8");
    } catch {
      return undefined;
    }
  } finally {
    closeSync(opened.fd);
  }
}

export function resultPath(dir: string, laneId: string): string {
  if (!LANE_ID_RE.test(laneId)) {
    throw new Error(`invalid lane id: ${JSON.stringify(laneId)}`);
  }
  return join(dir, `${laneId}.result.md`);
}

export function readManifest(dir: string): LaneSpec[] {
  const p = join(dir, "manifest.json");
  try {
    const raw = readTrustedRegularFile(p, dir);
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(validLane)) return [];
    const ids = new Set<string>();
    const panes = new Set<string>();
    for (const lane of parsed) {
      if (ids.has(lane.id) || (lane.paneId && panes.has(lane.paneId))) {
        return [];
      }
      ids.add(lane.id);
      if (lane.paneId) panes.add(lane.paneId);
    }
    return parsed;
  } catch {
    return [];
  }
}

export function collectDeliveries(
  dir: string,
  lanes: LaneSpec[],
  opts: { tmux?: TmuxApi } = {},
): CollectResult {
  // Only build a tmux client if some lane can report a (possibly dead) pane.
  const needPane = lanes.some((l) => l.paneId);
  const tmux = needPane ? (opts.tmux ?? makeTmux()) : opts.tmux;

  const results: LaneResult[] = lanes.map((lane) => {
    const file = resultPath(dir, lane.id);
    const output = readTrustedRegularFile(file, dir) ?? "";
    if (output) return { id: lane.id, name: lane.name, status: "done", output };
    if (lane.paneId && tmux?.paneDead(lane.paneId)) {
      return { id: lane.id, name: lane.name, status: "dead", output: "" };
    }
    return { id: lane.id, name: lane.name, status: "working", output: "" };
  });

  const doneCount = results.filter((l) => l.status !== "working").length;
  return { dir, lanes: results, total: results.length, doneCount, allDone: doneCount === results.length };
}

export function formatCollect(result: CollectResult): string {
  const head = `team collect: ${result.doneCount}/${result.total} delivered${result.allDone ? " — ALL DONE" : ""}`;
  const rows = result.lanes.map((l) => {
    const label = l.name ? `${l.id} (${l.name})` : l.id;
    if (l.status === "done") return `\n── ${label}: done ──\n${l.output.trimEnd()}`;
    if (l.status === "dead") return `\n── ${label}: dead (pane exited, no result) ──`;
    return `\n── ${label}: working ──`;
  });
  return head + rows.join("\n");
}
