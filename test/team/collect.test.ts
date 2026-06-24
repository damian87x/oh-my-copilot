import { describe, expect, it } from "vitest";
import { collectPanes, formatCollect } from "../../src/team/collect.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";

function fakeTmux(map: Record<string, { dead?: boolean; capture?: string }>): TmuxApi {
  return {
    paneDead: (t: string) => Boolean(map[t]?.dead),
    capturePane: (t: string) => ({ stdout: map[t]?.capture ?? "" }) as TmuxResult,
  } as unknown as TmuxApi;
}

describe("collectPanes", () => {
  it("classifies working / done / dead and captures done output", () => {
    const tmux = fakeTmux({
      "%1": { capture: "Analyzing the file…\n◉ Working esc cancel" }, // active task → working
      "%2": { capture: "● 42\n~/repo\n / commands · ? help\n❯ " }, // idle prompt → done
      "%3": { dead: true }, // pane exited → dead
    });
    const r = collectPanes(["%1", "%2", "%3"], { tmux });
    expect(r.total).toBe(3);
    expect(r.lanes[0]?.status).toBe("working");
    expect(r.lanes[1]?.status).toBe("done");
    expect(r.lanes[1]?.output).toContain("42");
    expect(r.lanes[2]?.status).toBe("dead");
    expect(r.doneCount).toBe(2); // done + dead are terminal
    expect(r.allDone).toBe(false);
  });

  it("allDone is true only when every lane is terminal", () => {
    const tmux = fakeTmux({
      "%2": { capture: "● Paris\n❯ " },
      "%3": { dead: true },
    });
    const r = collectPanes(["%2", "%3"], { tmux });
    expect(r.allDone).toBe(true);
    expect(r.doneCount).toBe(2);
  });

  it("classifies done when Copilot draws its input box with block-border chars", () => {
    // Regression: newer Copilot renders the input box with block chars
    // (╻▄ ┃ ╹▀), not ─━═ dashes, so a bottom-up prompt scan bails. The idle
    // footer "/ commands · ? help" must still classify the pane as done.
    const boxRendered = [
      "  Effort to fix: ~30 min (draft template + rewrite process).",
      "",
      " ~/workspace/MoltCore-workspace [⎇ feature/x*%]                Session: 4.32 AIC used",
      "╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
      "┃",
      "╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
      " / commands · ? help · tab next tab                                Claude Haiku 4.5",
    ].join("\n");
    const tmux = fakeTmux({ "%9": { capture: boxRendered } });
    const r = collectPanes(["%9"], { tmux });
    expect(r.lanes[0]?.status).toBe("done");
    expect(r.allDone).toBe(true);
  });

  it("formatCollect summarises done/total and shows done output", () => {
    const tmux = fakeTmux({ "%2": { capture: "● Paris\n❯ " } });
    const text = formatCollect(collectPanes(["%2"], { tmux }));
    expect(text).toContain("1/1 done");
    expect(text).toContain("ALL DONE");
    expect(text).toContain("Paris");
  });
});
