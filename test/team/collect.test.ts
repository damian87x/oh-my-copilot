import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDeliveries, formatCollect, readManifest, resultPath } from "../../src/team/collect.js";
import type { TmuxApi } from "../../src/team/tmux.js";

function fakeTmux(dead: Record<string, boolean>): TmuxApi {
  return { paneDead: (t: string) => Boolean(dead[t]) } as unknown as TmuxApi;
}

describe("collectDeliveries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "collect-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a lane is done only once its result file exists, and carries the content", () => {
    const lanes = [
      { id: "lane-a", name: "Math", paneId: "%1" },
      { id: "lane-b", name: "Geo", paneId: "%2" },
    ];
    // Nothing delivered yet — both working, even though panes are alive.
    let r = collectDeliveries(dir, lanes, { tmux: fakeTmux({}) });
    expect(r.allDone).toBe(false);
    expect(r.lanes.map((l) => l.status)).toEqual(["working", "working"]);

    // lane-a delivers.
    writeFileSync(resultPath(dir, "lane-a"), "42");
    r = collectDeliveries(dir, lanes, { tmux: fakeTmux({}) });
    expect(r.doneCount).toBe(1);
    expect(r.allDone).toBe(false);
    expect(r.lanes[0]?.status).toBe("done");
    expect(r.lanes[0]?.output).toContain("42");

    // lane-b delivers → allDone.
    writeFileSync(resultPath(dir, "lane-b"), "Paris");
    r = collectDeliveries(dir, lanes, { tmux: fakeTmux({}) });
    expect(r.allDone).toBe(true);
    expect(r.lanes[1]?.output).toContain("Paris");
  });

  it("a crashed pane with no delivery is dead (and counts as terminal)", () => {
    const lanes = [{ id: "lane-a", name: "Math", paneId: "%1" }];
    const r = collectDeliveries(dir, lanes, { tmux: fakeTmux({ "%1": true }) });
    expect(r.lanes[0]?.status).toBe("dead");
    expect(r.allDone).toBe(true);
  });

  it("a delivered file wins even if the pane later died", () => {
    const lanes = [{ id: "lane-a", paneId: "%1" }];
    writeFileSync(resultPath(dir, "lane-a"), "done");
    const r = collectDeliveries(dir, lanes, { tmux: fakeTmux({ "%1": true }) });
    expect(r.lanes[0]?.status).toBe("done");
  });

  it("readManifest reads the launcher's lane→pane map", () => {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify([{ id: "lane-a", name: "Math", paneId: "%1" }]));
    expect(readManifest(dir)).toEqual([{ id: "lane-a", name: "Math", paneId: "%1" }]);
    expect(readManifest(join(dir, "nope"))).toEqual([]);
  });

  it("formatCollect summarises delivered/total and shows done output", () => {
    writeFileSync(resultPath(dir, "lane-a"), "Paris");
    const text = formatCollect(collectDeliveries(dir, [{ id: "lane-a", name: "Geo" }]));
    expect(text).toContain("1/1 delivered");
    expect(text).toContain("ALL DONE");
    expect(text).toContain("Paris");
  });
});
