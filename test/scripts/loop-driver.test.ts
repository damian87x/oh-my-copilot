import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs hook helper, no types
import { decideLoop } from "../../scripts/lib/loop-driver.mjs";

describe("decideLoop", () => {
  it("allows a normal stop when no loop is active", () => {
    expect(decideLoop({}, "").decision).toBe("allow");
    expect(decideLoop({ ralph: { active: false } }, "").decision).toBe("allow");
  });

  it("blocks and increments the counter while a ralph loop is incomplete", () => {
    const r = decideLoop({ ralph: { active: true, iteration: 0, maxIterations: 3 } }, "");
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("[RALPH ITERATION 1/3]");
    expect(r.patch).toEqual({ mode: "ralph", counter: "iteration", value: 1 });
  });

  it("allows and clears the loop when the completion sentinel is present", () => {
    const r = decideLoop(
      { ralph: { active: true, iteration: 1, maxIterations: 10 } },
      "did the work\nRALPH_COMPLETE\n",
    );
    expect(r.decision).toBe("allow");
    expect(r.clear).toBe("ralph");
  });

  it("allows (caps) when the next iteration would reach the maximum", () => {
    const r = decideLoop({ ralph: { active: true, iteration: 2, maxIterations: 3 } }, "");
    expect(r.decision).toBe("allow");
    expect(r.clear).toBe("ralph");
    expect(r.reason).toContain("max (3)");
  });

  it("drives ultraqa via cycleCount/maxCycles", () => {
    const r = decideLoop({ ultraqa: { active: true, cycleCount: 0, maxCycles: 5 } }, "");
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("[ULTRAQA ITERATION 1/5]");
    expect(r.patch).toEqual({ mode: "ultraqa", counter: "cycleCount", value: 1 });
  });

  it("prioritizes ralph over other active loops", () => {
    const r = decideLoop(
      { ralph: { active: true, iteration: 0, maxIterations: 4 }, ultraqa: { active: true, cycleCount: 0, maxCycles: 5 } },
      "",
    );
    expect(r.reason).toContain("RALPH");
  });
});
