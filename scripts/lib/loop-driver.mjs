// Pure decision logic for the agentStop loop driver. Given the current loop-mode
// states and the session transcript text, decide whether Copilot should stop
// (`allow`) or take another turn (`block` + a next-turn `reason`). Kept side-effect
// free so it is unit-testable; file I/O lives in scripts/agent-stop.mjs.

// Priority order: a single-owner ralph loop wins over a QA cycle over a batch.
export const LOOP_MODES = [
  { key: "ralph", sentinel: "RALPH_COMPLETE", counter: "iteration", max: "maxIterations", defMax: 10 },
  { key: "ultraqa", sentinel: "ULTRAQA_COMPLETE", counter: "cycleCount", max: "maxCycles", defMax: 5 },
  { key: "ultrawork", sentinel: "ULTRAWORK_COMPLETE", counter: "iteration", max: "maxIterations", defMax: 20 },
];

/**
 * @param {Record<string, any>} states  e.g. { ralph: {active, iteration, maxIterations}, ... }
 * @param {string} transcriptText        recent transcript text to scan for a completion sentinel
 * @returns {{decision:"allow"|"block", reason?:string, clear?:string, patch?:{mode:string,counter:string,value:number}}}
 */
export function decideLoop(states = {}, transcriptText = "") {
  for (const m of LOOP_MODES) {
    const s = states[m.key];
    if (!s || !s.active) continue;

    // The model signals completion by emitting the sentinel token — let it stop.
    if (transcriptText.includes(m.sentinel)) {
      return { decision: "allow", clear: m.key, reason: `${m.key} complete (sentinel seen)` };
    }

    const cur = Number(s[m.counter] ?? 0);
    const max = Number(s[m.max] ?? m.defMax);
    // Safety cap: never loop past the configured maximum, even without a sentinel.
    if (cur + 1 >= max) {
      return { decision: "allow", clear: m.key, reason: `${m.key} reached max (${max})` };
    }

    const next = cur + 1;
    const reason =
      `[${m.key.toUpperCase()} ITERATION ${next}/${max}] Not finished. Continue the task. ` +
      `When ALL acceptance criteria pass, output the exact token ${m.sentinel} on its own line.`;
    return { decision: "block", patch: { mode: m.key, counter: m.counter, value: next }, reason };
  }

  // No active loop — normal stop.
  return { decision: "allow" };
}
