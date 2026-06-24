import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function resultPath(dir: string, laneId: string): string {
  return join(dir, `${laneId}.result.md`);
}

export function readManifest(dir: string): LaneSpec[] {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed) ? (parsed as LaneSpec[]) : [];
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
    if (existsSync(file)) {
      let output = "";
      try {
        output = readFileSync(file, "utf8");
      } catch {
        /* file vanished between checks — treat as still working */
      }
      if (output) return { id: lane.id, name: lane.name, status: "done", output };
    }
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
