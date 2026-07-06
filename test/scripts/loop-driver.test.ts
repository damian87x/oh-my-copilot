import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs hook helper, no types
import { decideLoop, extractAssistantText } from "../../scripts/lib/loop-driver.mjs";

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

  // Issue #75: the hook's own injected continuation prompt quotes the sentinel
  // mid-sentence and flows back through the transcript on the next stop — it
  // must never count as completion.
  it("does not treat the injected continuation instruction as completion", () => {
    const injected =
      "[RALPH ITERATION 1/3] Not finished. Continue the task. " +
      "When ALL acceptance criteria pass, output the exact token RALPH_COMPLETE on its own line.";
    const r = decideLoop({ ralph: { active: true, iteration: 1, maxIterations: 3 } }, injected);
    expect(r.decision).toBe("block");
    expect(r.patch).toEqual({ mode: "ralph", counter: "iteration", value: 2 });
  });

  it("matches the sentinel only on its own line", () => {
    const state = () => ({ ralph: { active: true, iteration: 1, maxIterations: 10 } });
    expect(decideLoop(state(), "mentioning RALPH_COMPLETE mid-sentence").decision).toBe("block");
    expect(decideLoop(state(), "prefix RALPH_COMPLETED\n").decision).toBe("block");
    expect(decideLoop(state(), "done\n  RALPH_COMPLETE  \nmore").decision).toBe("allow");
    expect(decideLoop(state(), "RALPH_COMPLETE").decision).toBe("allow");
  });
});

describe("extractAssistantText", () => {
  it("returns only assistant.message content from an events.jsonl tail", () => {
    const tail = [
      JSON.stringify({
        type: "user.message",
        data: {
          content: "go",
          transformedContent:
            "[RALPH ITERATION 1/3] output the exact token RALPH_COMPLETE on its own line.",
        },
      }),
      JSON.stringify({ type: "assistant.message", data: { content: "step one done" } }),
      JSON.stringify({ type: "assistant.turn_end", data: {} }),
      JSON.stringify({ type: "assistant.message", data: { content: "all good\nRALPH_COMPLETE" } }),
    ].join("\n");
    expect(extractAssistantText(tail)).toBe("step one done\nall good\nRALPH_COMPLETE");
  });

  it("passes plain-text transcripts through unchanged", () => {
    expect(extractAssistantText("did the work\nRALPH_COMPLETE\n")).toBe("did the work\nRALPH_COMPLETE\n");
  });

  it("skips a partial first line from the tail cut and non-JSON noise", () => {
    const tail =
      '"content": "truncated head"}\n' +
      "not json\n" +
      JSON.stringify({ type: "assistant.message", data: { content: "hello" } });
    expect(extractAssistantText(tail)).toBe("hello");
  });

  it("returns empty text when events exist but none are assistant messages", () => {
    const tail = JSON.stringify({
      type: "user.message",
      data: { content: "go", transformedContent: "RALPH_COMPLETE" },
    });
    expect(extractAssistantText(tail)).toBe("");
  });
});
