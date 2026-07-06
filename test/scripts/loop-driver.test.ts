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

  it("allows (caps) only after the configured number of ralph continuations", () => {
    const fourth = decideLoop({ ralph: { active: true, iteration: 3, maxIterations: 4 } }, "");
    expect(fourth.decision).toBe("block");
    expect(fourth.reason).toContain("[RALPH ITERATION 4/4]");
    expect(fourth.patch).toEqual({ mode: "ralph", counter: "iteration", value: 4 });

    const r = decideLoop({ ralph: { active: true, iteration: 4, maxIterations: 4 } }, "");
    expect(r.decision).toBe("allow");
    expect(r.clear).toBe("ralph");
    expect(r.reason).toContain("max (4)");
  });

  it("keeps the safety cap when max is non-numeric (never fails open into an unbounded loop)", () => {
    // A corrupted maxIterations must fall back to the mode default, not NaN — a
    // NaN cap makes `cur >= max` always false and the loop never stops.
    const capped = decideLoop({ ralph: { active: true, iteration: 500, maxIterations: "abc" } }, "");
    expect(capped.decision).toBe("allow");
    expect(capped.clear).toBe("ralph");
    expect(capped.reason).toContain("max (10)");
  });

  it("treats a non-numeric counter as 0 rather than propagating NaN", () => {
    const r = decideLoop({ ralph: { active: true, iteration: "oops", maxIterations: 4 } }, "");
    expect(r.decision).toBe("block");
    expect(r.patch).toEqual({ mode: "ralph", counter: "iteration", value: 1 });
  });

  it("drives ultraqa via cycleCount/maxCycles", () => {
    const r = decideLoop({ ultraqa: { active: true, cycleCount: 0, maxCycles: 5 } }, "");
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("[ULTRAQA CYCLE 1/5]");
    expect(r.patch).toEqual({ mode: "ultraqa", counter: "cycleCount", value: 1 });
  });

  it("allows ultraqa exactly at maxCycles after granting N continuations", () => {
    const fourth = decideLoop({ ultraqa: { active: true, cycleCount: 3, maxCycles: 4 } }, "");
    expect(fourth.decision).toBe("block");
    expect(fourth.patch).toEqual({ mode: "ultraqa", counter: "cycleCount", value: 4 });

    const capped = decideLoop({ ultraqa: { active: true, cycleCount: 4, maxCycles: 4 } }, "");
    expect(capped.decision).toBe("allow");
    expect(capped.clear).toBe("ultraqa");
  });

  it("allows ultrawork exactly at maxIterations after granting N continuations", () => {
    const fourth = decideLoop({ ultrawork: { active: true, iteration: 3, maxIterations: 4 } }, "");
    expect(fourth.decision).toBe("block");
    expect(fourth.patch).toEqual({ mode: "ultrawork", counter: "iteration", value: 4 });

    const capped = decideLoop({ ultrawork: { active: true, iteration: 4, maxIterations: 4 } }, "");
    expect(capped.decision).toBe("allow");
    expect(capped.clear).toBe("ultrawork");
  });

  it("prioritizes ralph over other active loops", () => {
    const r = decideLoop(
      { ralph: { active: true, iteration: 0, maxIterations: 4 }, ultraqa: { active: true, cycleCount: 0, maxCycles: 5 } },
      "",
    );
    expect(r.reason).toContain("RALPH");
  });
});
