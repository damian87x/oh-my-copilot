import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { appendCostRecord } from "../cost/ledger.js";
import { isModelUnavailable } from "../council/types.js";
import type { CouncilSpawn } from "../council/types.js";
import { readMemoryConfig } from "./config.js";
import { claimSession, releaseClaim } from "./guard.js";
import { isValidSessionId, readSessionTranscript, type TranscriptMessage } from "./transcript.js";
import { buildReviewPrompt, parseReviewOutput } from "./prompt.js";
import { applyReview, type ApplySummary } from "./apply.js";
import { existingSkillSlugs, pendingDirectiveTexts } from "./quarantine.js";
import { pruneNotes, readDirectives, recentNotes } from "../project-memory.js";

// End-of-session review pass — the Copilot analog of Hermes's background-review
// fork. Triggered detached (sessionEnd hook) or post-exit (wrapper for `-p`).
// Pure orchestration with injectable spawn / transcript reader so tests exercise
// the real logic without spawning copilot or touching the real home dir.

export interface RunMemoryReviewOptions {
  cwd: string;
  sessionId: string;
  spawn: CouncilSpawn;
  readTranscript?: (uuid: string) => TranscriptMessage[];
  model?: string;
  timeoutMs?: number;
}

export interface RunMemoryReviewResult {
  ran: boolean;
  reason?: string;
  summary?: ApplySummary;
}

function logLine(cwd: string, payload: Record<string, unknown>): void {
  try {
    const p = join(ompRoot(cwd), ".omp", "state", "memory-review.log");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`);
  } catch {
    // logging is best-effort
  }
}

export async function runMemoryReview(
  options: RunMemoryReviewOptions,
): Promise<RunMemoryReviewResult> {
  const { cwd, sessionId } = options;
  const config = readMemoryConfig(cwd);

  if (config.memoryMode !== "on") return { ran: false, reason: "memory-mode off" };
  if (!sessionId) return { ran: false, reason: "no session id" };
  if (!isValidSessionId(sessionId)) return { ran: false, reason: "invalid session id" };

  // Read the transcript BEFORE claiming — an empty session never consumes a
  // claim, so a session that later grows can still be reviewed.
  const read = options.readTranscript ?? ((uuid: string) => readSessionTranscript(uuid));
  const messages = read(sessionId);
  if (messages.length === 0) {
    logLine(cwd, { sessionId, ran: false, reason: "empty transcript" });
    return { ran: false, reason: "empty transcript" };
  }
  // Skip trivial sessions (cost control) — don't spend a model call or consume
  // a claim on a session too short to have produced durable knowledge.
  if (messages.length < config.memoryReviewMinMessages) {
    logLine(cwd, { sessionId, ran: false, reason: "below min-messages threshold" });
    return { ran: false, reason: "below min-messages threshold" };
  }

  // Atomic claim only once we're committed to spending the model call, so a
  // near-simultaneous hook + wrapper run resolves to exactly one execution.
  if (!claimSession(cwd, sessionId)) return { ran: false, reason: "already claimed" };

  const model = options.model ?? config.memoryReviewModel;
  // Tell the model what memory already holds so routine detection (automated
  // self-evolve) extends knowledge instead of re-proposing it every session;
  // applyReview dedups again as a hard backstop.
  const prompt = buildReviewPrompt(messages, {
    skillSlugs: existingSkillSlugs(cwd),
    directives: [...readDirectives(cwd), ...pendingDirectiveTexts(cwd)],
    // Newest note titles (bounded) — the reviewer must extend notes, not
    // re-propose near-duplicates; apply-layer dedup only catches exact matches,
    // so without this the same fact returns under a new title every session.
    noteTitles: recentNotes(cwd, 50).map((n) => n.title),
  });
  const timeoutMs = options.timeoutMs ?? 90_000;

  const res = await options.spawn({ model, prompt, timeoutMs });
  // An unavailable model is a permanent config error, not a transient failure:
  // surface an actionable fix instead of the generic message below. Detached
  // sessionEnd reviews would otherwise fail this way silently every session.
  if (isModelUnavailable(res)) {
    releaseClaim(cwd, sessionId);
    const reason = `review model '${model}' not available — run: omp config set memory-review-model <slug>`;
    logLine(cwd, { sessionId, ran: false, reason, model });
    return { ran: false, reason };
  }
  if (res.exitCode !== 0 || res.timedOut) {
    // Nothing was written — release the claim so the session can be retried.
    releaseClaim(cwd, sessionId);
    const reason = `review model failed (exit=${res.exitCode}, timedOut=${res.timedOut})`;
    logLine(cwd, { sessionId, ran: false, reason });
    return { ran: false, reason };
  }

  const parsed = parseReviewOutput(res.stdout);
  if (!parsed) {
    releaseClaim(cwd, sessionId);
    logLine(cwd, { sessionId, ran: false, reason: "unparseable review output" });
    return { ran: false, reason: "unparseable review output" };
  }

  const summary = applyReview(cwd, parsed);

  // Optional lifecycle: auto-prune old notes so the injected title cap stays
  // meaningful as reviews keep adding. Off by default (memoryNoteAutoKeep = 0);
  // manual `omp project-memory prune-notes` remains the explicit path.
  let autoPrunedIds: string[] = [];
  if (config.memoryNoteAutoKeep > 0) {
    try {
      autoPrunedIds = pruneNotes(cwd, { keep: config.memoryNoteAutoKeep });
    } catch {
      // pruning is best-effort — never fail the review on it
    }
  }

  // Refresh the injected memory block so newly written notes surface in the
  // NEXT session (closes the loop). Best-effort — never fail the review on it.
  if (summary.notesAdded > 0 || autoPrunedIds.length > 0) {
    try {
      const { syncInstructionsMemory } = await import("../instructions-memory.js");
      syncInstructionsMemory(cwd);
    } catch {
      // sync is best-effort
    }
  }

  appendCostRecord(cwd, {
    sessionId,
    event: "memory-review",
    model,
    inTokens: Math.ceil(prompt.length / 4),
    outTokens: Math.ceil(res.stdout.length / 4),
    note: `notes=${summary.notesAdded} drafts=${summary.draftsWritten.length} directivesQueued=${summary.directivesQueued}`,
  });

  logLine(cwd, { sessionId, ran: true, ...summary, autoPruned: autoPrunedIds.length, autoPrunedIds });
  return { ran: true, summary };
}
