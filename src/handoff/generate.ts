import { execFileSync } from "node:child_process";
import { readRepoGoal } from "../goal.js";
import { readDailyLog } from "../daily-log.js";
import { traceSummary, traceTimeline } from "../trace.js";
import { sanitizeHandoffText } from "./redact.js";
import type { CreateHandoffInput, HandoffReference } from "./types.js";

/** Bounds for deterministic packet fields (no unbounded dumps). */
export const HANDOFF_BOUNDS = {
  maxObjectiveChars: 400,
  maxListItems: 20,
  maxItemChars: 200,
  maxFiles: 40,
  maxTraceEvents: 30,
  maxGitStatusLines: 40,
  maxPacketChars: 12_000,
  maxRefChars: 240,
} as const;

export interface DeterministicDraft {
  objective: string;
  done: string[];
  pending: string[];
  blockers: string[];
  files_touched: string[];
  verification_status: string;
  next_action: string;
  references: HandoffReference[];
  suggested_skills: string[];
  focus?: string;
  /** Diagnostics for tests (never stored as secrets). */
  sources: {
    git: boolean;
    trace: boolean;
    goal: boolean;
    daily: boolean;
  };
}

export function clampText(s: string, max: number): string {
  const t = sanitizeHandoffText(String(s ?? "")).replace(/\s*\n\s*/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function clampList(items: string[], maxItems: number = HANDOFF_BOUNDS.maxListItems): string[] {
  return items
    .map((i) => clampText(i, HANDOFF_BOUNDS.maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

function gitFilesTouched(cwd: string): string[] {
  const status = runGit(cwd, ["status", "--porcelain", "-uall", "-z"]);
  const files = new Set<string>();
  if (status) {
    // -z: records separated by NUL; each entry is "XY path" or "XY old\0new" for renames.
    for (const rec of status.split("\0")) {
      if (!rec || rec.length < 3) continue;
      const rest = rec.slice(3);
      if (!rest) continue;
      files.add(rest.replace(/^"+|"+$/g, ""));
      if (files.size >= HANDOFF_BOUNDS.maxFiles) break;
    }
  } else {
    // Fallback when -z unavailable / empty.
    const plain = runGit(cwd, ["status", "--porcelain", "-uall"]);
    for (const line of plain.split("\n").slice(0, HANDOFF_BOUNDS.maxGitStatusLines)) {
      if (!line.trim()) continue;
      const rest = line.slice(3).trim();
      if (!rest) continue;
      if (rest.includes(" -> ")) {
        const [from, to] = rest.split(" -> ");
        if (from) files.add(from.trim());
        if (to) files.add(to.trim());
      } else {
        files.add(rest);
      }
    }
  }
  return [...files].slice(0, HANDOFF_BOUNDS.maxFiles);
}

function gitBranch(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function gitShortLog(cwd: string): string[] {
  const log = runGit(cwd, ["log", "-5", "--pretty=format:%h %s"]);
  if (!log) return [];
  return log.split("\n").filter(Boolean).slice(0, 5);
}

function clampRef(ref: HandoffReference): HandoffReference {
  return {
    label: ref.label ? clampText(ref.label, 80) : undefined,
    path: ref.path ? clampText(ref.path, HANDOFF_BOUNDS.maxRefChars) : undefined,
    url: ref.url ? clampText(ref.url, HANDOFF_BOUNDS.maxRefChars) : undefined,
  };
}

/**
 * Build a handoff draft from git status/diff, recent traces, and session memory.
 * Purely deterministic — never invokes a model.
 */
export function buildDeterministicDraft(cwd: string, input: CreateHandoffInput = {}): DeterministicDraft {
  const sources = { git: false, trace: false, goal: false, daily: false };

  const files = input.files_touched?.length
    ? clampList(input.files_touched, HANDOFF_BOUNDS.maxFiles)
    : (() => {
        const f = gitFilesTouched(cwd);
        if (f.length) sources.git = true;
        return f;
      })();

  const branch = gitBranch(cwd);
  if (branch) sources.git = true;
  const recentCommits = gitShortLog(cwd);
  if (recentCommits.length) sources.git = true;

  const timeline = traceTimeline(cwd, undefined, HANDOFF_BOUNDS.maxTraceEvents);
  const summary = traceSummary(cwd, timeline.sessionId);
  if (summary.total > 0) sources.trace = true;

  const goal = readRepoGoal(cwd);
  if (goal) sources.goal = true;

  const daily = readDailyLog(cwd, 1);
  if (daily) sources.daily = true;

  // Only structured done/blockers from traces — raw tool events are not "pending work".
  const doneFromTrace: string[] = [];
  const blockersFromTrace: string[] = [];
  for (const e of timeline.entries) {
    const event = e.event ?? "event";
    const payload =
      e.payload === undefined
        ? ""
        : typeof e.payload === "string"
          ? e.payload
          : JSON.stringify(e.payload);
    const line = clampText(`${event}${payload ? `: ${payload}` : ""}`, HANDOFF_BOUNDS.maxItemChars);
    if (/fail|error|block/i.test(event)) blockersFromTrace.push(line);
    else if (/done|complete|pass|success/i.test(event)) doneFromTrace.push(line);
  }

  const objective =
    clampText(input.objective ?? "", HANDOFF_BOUNDS.maxObjectiveChars) ||
    (goal ? clampText(goal, HANDOFF_BOUNDS.maxObjectiveChars) : "") ||
    (branch ? `Continue work on branch ${branch}` : "Continue unfinished task");

  const done = input.done?.length
    ? clampList(input.done)
    : clampList([
        ...doneFromTrace.slice(-10),
        ...recentCommits.map((c) => `commit: ${c}`),
      ]);

  const pending = input.pending?.length
    ? clampList(input.pending)
    : clampList(
        files.length
          ? [`Review/finish changes in ${files.length} file(s)`]
          : summary.total > 0
            ? [`Continue session ${timeline.sessionId ?? "latest"} (${summary.total} events)`]
            : ["Resume from last known state"],
      );

  const blockers = input.blockers?.length ? clampList(input.blockers) : clampList(blockersFromTrace);

  const verification_status = clampText(
    input.verification_status ??
      (summary.counts.fail || summary.counts.error
        ? "unverified — recent failures in trace"
        : files.length
          ? "unverified — dirty tree"
          : "unknown"),
    HANDOFF_BOUNDS.maxItemChars,
  );

  const focus = input.focus ? clampText(input.focus, HANDOFF_BOUNDS.maxItemChars) : undefined;

  const next_action = clampText(
    input.next_action ??
      (focus
        ? `Focus: ${focus}`
        : pending[0]
          ? `Next: ${pending[0]}`
          : "Inspect handoff and continue pending work"),
    HANDOFF_BOUNDS.maxItemChars,
  );

  const references: HandoffReference[] = [];
  if (input.references?.length) {
    for (const r of input.references.slice(0, HANDOFF_BOUNDS.maxListItems - 2)) {
      references.push(clampRef(r));
    }
  }
  if (branch && !references.some((r) => r.label === "branch")) {
    references.push(clampRef({ label: "branch", path: branch }));
  }
  if (timeline.sessionId && references.length < HANDOFF_BOUNDS.maxListItems) {
    references.push(
      clampRef({ label: "trace-session", path: `.omp/state/trace/${timeline.sessionId}.jsonl` }),
    );
  }

  const suggested_skills = clampList(
    input.suggested_skills?.length
      ? input.suggested_skills
      : ["handoff", "daily-log", "tdd", "verify"],
    10,
  );

  const draft: DeterministicDraft = {
    objective,
    done,
    pending,
    blockers,
    files_touched: files,
    verification_status,
    next_action,
    references: references.slice(0, HANDOFF_BOUNDS.maxListItems),
    suggested_skills,
    focus,
    sources,
  };
  return enforceDraftBounds(draft);
}

/** Ensure draft (including refs/skills/focus) stays under maxPacketChars. */
export function enforceDraftBounds(draft: DeterministicDraft): DeterministicDraft {
  const d: DeterministicDraft = {
    ...draft,
    objective: clampText(draft.objective, HANDOFF_BOUNDS.maxObjectiveChars),
    done: clampList(draft.done),
    pending: clampList(draft.pending),
    blockers: clampList(draft.blockers),
    files_touched: clampList(draft.files_touched, HANDOFF_BOUNDS.maxFiles),
    verification_status: clampText(draft.verification_status, HANDOFF_BOUNDS.maxItemChars),
    next_action: clampText(draft.next_action, HANDOFF_BOUNDS.maxItemChars),
    references: draft.references.map(clampRef).slice(0, HANDOFF_BOUNDS.maxListItems),
    suggested_skills: clampList(draft.suggested_skills, 10),
    focus: draft.focus ? clampText(draft.focus, HANDOFF_BOUNDS.maxItemChars) : undefined,
  };

  // Shrink lists until under the packet budget (count includes all fields).
  while (draftCharCount(d) > HANDOFF_BOUNDS.maxPacketChars) {
    if (d.done.length > 3) d.done.pop();
    else if (d.pending.length > 1) d.pending.pop();
    else if (d.blockers.length > 0) d.blockers.pop();
    else if (d.files_touched.length > 5) d.files_touched.pop();
    else if (d.references.length > 0) d.references.pop();
    else if (d.suggested_skills.length > 1) d.suggested_skills.pop();
    else {
      d.objective = clampText(d.objective, Math.max(40, Math.floor(d.objective.length * 0.7)));
      d.next_action = clampText(d.next_action, Math.max(20, Math.floor(d.next_action.length * 0.7)));
      break;
    }
  }
  return d;
}

/**
 * Optional LLM summarization hook. Callers that request --llm / auto-LLM MUST
 * provide a real summarizer; there is no default that fabricates model_calls.
 */
export type HandoffSummarizer = (
  draft: DeterministicDraft,
  focus?: string,
) => Promise<{ draft: DeterministicDraft; model_calls: number; warning: string }>;

export const LLM_COST_WARNING =
  "LLM handoff generation is cost-bearing (one summarization call). Prefer deterministic create unless you need a narrative summary.";

export const LLM_NOT_IMPLEMENTED =
  "LLM handoff generation is not implemented. Omit --llm for deterministic create (or inject a summarizer in tests/integrations).";

export class LlmHandoffNotImplementedError extends Error {
  constructor(message = LLM_NOT_IMPLEMENTED) {
    super(message);
    this.name = "LlmHandoffNotImplementedError";
  }
}

/** Serialize a draft for size checks (all fields that land in the artifact). */
export function draftCharCount(draft: DeterministicDraft): number {
  return JSON.stringify({
    objective: draft.objective,
    done: draft.done,
    pending: draft.pending,
    blockers: draft.blockers,
    files_touched: draft.files_touched,
    verification_status: draft.verification_status,
    next_action: draft.next_action,
    references: draft.references,
    suggested_skills: draft.suggested_skills,
    focus: draft.focus,
  }).length;
}
