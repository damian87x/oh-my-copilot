// Pure decision logic for the agentStop loop driver. Given the current loop-mode
// states and the session transcript text, decide whether Copilot should stop
// (`allow`) or take another turn (`block` + a next-turn `reason`). Kept side-effect
// free so it is unit-testable; file I/O lives in scripts/agent-stop.mjs.

// Priority order: a single-owner ralph loop wins over a QA cycle over a batch.
export const LOOP_MODES = [
  { key: "ralph", sentinel: "RALPH_COMPLETE", counter: "iteration", max: "maxIterations", defMax: 10, unit: "ITERATION" },
  { key: "ultraqa", sentinel: "ULTRAQA_COMPLETE", counter: "cycleCount", max: "maxCycles", defMax: 5, unit: "CYCLE" },
  { key: "ultrawork", sentinel: "ULTRAWORK_COMPLETE", counter: "iteration", max: "maxIterations", defMax: 20, unit: "ITERATION" },
];

// Copilot transcripts are events.jsonl; only assistant.message content is the
// model's own output. The hook's injected continuation prompt flows back inside
// user.message events and must not be scanned for completion sentinels (#75).
// Plain-text transcripts (no parseable events) pass through unchanged.
export function extractAssistantText(tailText = "") {
  let sawEvent = false;
  const chunks = [];
  for (const line of String(tailText).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // tail read can cut the first line mid-JSON — skip it
    }
    if (!event || typeof event.type !== "string") continue;
    sawEvent = true;
    if (event.type === "assistant.message" && typeof event.data?.content === "string") {
      chunks.push(event.data.content);
    }
  }
  return sawEvent ? chunks.join("\n") : String(tailText);
}

// The sentinel counts only on its own line: the injected continuation prompt
// quotes it mid-sentence ("output the exact token RALPH_COMPLETE on its own
// line") and would otherwise match itself on the next stop (#75).
function sentinelSeen(transcriptText, sentinel) {
  return new RegExp(`^\\s*${sentinel}\\s*$`, "m").test(transcriptText);
}

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
    if (sentinelSeen(transcriptText, m.sentinel)) {
      return { decision: "allow", clear: m.key, reason: `${m.key} complete (sentinel seen)` };
    }

    const rawCur = Number(s[m.counter] ?? 0);
    const cur = Number.isFinite(rawCur) ? rawCur : 0;
    // A corrupted non-numeric max (e.g. "abc") must NOT disable the cap: Number()
    // would yield NaN and `cur >= NaN` is always false — an unbounded loop in the
    // one component meant to be the backstop. Fall back to the mode default so the
    // safety cap always holds.
    const rawMax = Number(s[m.max] ?? m.defMax);
    const max = Number.isFinite(rawMax) ? rawMax : m.defMax;
    // Safety cap: max=N grants exactly N hook-driven continuation turns.
    if (cur >= max) {
      return { decision: "allow", clear: m.key, reason: `${m.key} reached max (${max})` };
    }

    const next = cur + 1;
    const reason =
      `[${m.key.toUpperCase()} ${m.unit} ${next}/${max}] Not finished. Continue the task. ` +
      `When ALL acceptance criteria pass, output the exact token ${m.sentinel} on its own line.`;
    return { decision: "block", patch: { mode: m.key, counter: m.counter, value: next }, reason };
  }

  // No active loop — normal stop.
  return { decision: "allow" };
}
