import { makeTmux, paneHasActiveTask, paneLooksReady, type TmuxApi } from "./tmux.js";

// One-shot "collect" for the visual team flow: capture each worker pane, classify
// it, and return the done lanes' output. The team lead POLLS this in a loop until
// every lane is terminal, then synthesizes — the leader-driven poll model used by
// oh-my-codex (`omx team status` loop), rather than a daemon pushing pings.

export type LaneStatus = "done" | "working" | "dead";

export interface LaneResult {
  paneId: string;
  status: LaneStatus;
  /** Captured pane tail for terminal lanes (done/dead); empty while working. */
  output: string;
}

export interface CollectResult {
  lanes: LaneResult[];
  total: number;
  /** Terminal lanes (done or dead). */
  doneCount: number;
  allDone: boolean;
}

export function collectPanes(
  workerPaneIds: string[],
  opts: { lines?: number; tmux?: TmuxApi } = {},
): CollectResult {
  const tmux = opts.tmux ?? makeTmux();
  const lines = opts.lines ?? 200;
  const lanes: LaneResult[] = [];

  for (const paneId of workerPaneIds) {
    if (tmux.paneDead(paneId)) {
      lanes.push({ paneId, status: "dead", output: "" });
      continue;
    }
    const captured = tmux.capturePane(paneId, lines).stdout;
    let status: LaneStatus;
    if (paneHasActiveTask(captured)) status = "working";
    else if (paneLooksReady(captured)) status = "done";
    else status = "working"; // not ready yet (still starting) — treat as working
    lanes.push({ paneId, status, output: status === "done" ? captured : "" });
  }

  const doneCount = lanes.filter((l) => l.status !== "working").length;
  return { lanes, total: lanes.length, doneCount, allDone: doneCount === lanes.length };
}

export function formatCollect(result: CollectResult): string {
  const head = `team collect: ${result.doneCount}/${result.total} done${result.allDone ? " — ALL DONE" : ""}`;
  const rows = result.lanes.map((l) => {
    if (l.status === "done") return `\n── ${l.paneId} (done) ──\n${l.output.trimEnd()}`;
    if (l.status === "dead") return `\n── ${l.paneId} (dead — pane exited) ──`;
    return `\n── ${l.paneId} (working) ──`;
  });
  return head + rows.join("\n");
}
