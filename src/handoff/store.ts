import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, forceReleaseStaleLock } from "../schedule/lock.js";
import { atomicWrite, ensureDir, readJSON } from "../utils/fs.js";
import { assertValidHandoffId, newHandoffId } from "./id.js";
import {
  buildDeterministicDraft,
  draftCharCount,
  enforceDraftBounds,
  HANDOFF_BOUNDS,
  LLM_COST_WARNING,
  LlmHandoffNotImplementedError,
  type HandoffSummarizer,
} from "./generate.js";
import { handoffFilePath, handoffIndexPath, handoffsDir } from "./paths.js";
import { readHandoffConfig } from "./config.js";
import { sanitizeForInstructions, sanitizeHandoffText } from "./redact.js";
import type {
  CreateHandoffInput,
  CreateHandoffResult,
  Handoff,
  HandoffIndex,
  HandoffPointer,
  HandoffState,
} from "./types.js";

const INDEX_LOCK_MAX_AGE_MS = 30_000;
const INDEX_LOCK_RETRIES = 40;
const INDEX_LOCK_SPIN_MS = 25;

function emptyIndex(): HandoffIndex {
  return { version: 1, active: [] };
}

function indexLockPath(cwd: string): string {
  return join(handoffsDir(cwd), "index.lock");
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait: create/close are short critical sections; avoid async lock API surface
  }
}

/** Run `fn` while holding the handoff index lock (serializes concurrent updates). */
function withIndexLock<T>(cwd: string, fn: () => T): T {
  const lockPath = indexLockPath(cwd);
  ensureDir(lockPath);
  forceReleaseStaleLock(lockPath, INDEX_LOCK_MAX_AGE_MS);
  let handle = acquireLock(lockPath);
  for (let i = 0; !handle.acquired && i < INDEX_LOCK_RETRIES; i++) {
    sleepMs(INDEX_LOCK_SPIN_MS);
    forceReleaseStaleLock(lockPath, INDEX_LOCK_MAX_AGE_MS);
    handle = acquireLock(lockPath);
  }
  if (!handle.acquired) {
    throw new Error("could not acquire handoff index lock");
  }
  try {
    return fn();
  } finally {
    handle.release();
  }
}

function writeIndex(cwd: string, index: HandoffIndex): void {
  const p = handoffIndexPath(cwd);
  ensureDir(p);
  atomicWrite(p, `${JSON.stringify(index, null, 2)}\n`);
}

function writeHandoffFile(cwd: string, handoff: Handoff): string {
  assertValidHandoffId(handoff.id);
  const p = handoffFilePath(cwd, handoff.id);
  ensureDir(p);
  atomicWrite(p, `${JSON.stringify(handoff, null, 2)}\n`);
  return p;
}

function pointerOf(h: Handoff): HandoffPointer {
  return {
    id: h.id,
    objective: sanitizeForInstructions(h.objective).slice(0, 200),
    updated_at: h.updated_at,
  };
}

/** Scan disk for handoff files (source of truth). Skips index.json / locks. */
function scanHandoffFiles(cwd: string): Handoff[] {
  const dir = handoffsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: Handoff[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const id = f.slice(0, -".json".length);
    try {
      assertValidHandoffId(id);
    } catch {
      continue;
    }
    const h = readJSON<Handoff | null>(join(dir, f), null);
    if (!h || typeof h.id !== "string") continue;
    out.push(h);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * Recompute active index from on-disk handoff files (repairs drift / lost RMW).
 * Callers that mutate should hold the index lock.
 */
export function rebuildIndex(cwd: string): HandoffIndex {
  return withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
}

function rebuildIndexUnlocked(cwd: string): HandoffIndex {
  const active = scanHandoffFiles(cwd)
    .filter((h) => h.state === "active")
    .map(pointerOf);
  const idx: HandoffIndex = { version: 1, active };
  writeIndex(cwd, idx);
  return idx;
}

function persistHandoff(cwd: string, handoff: Handoff): string {
  const path = writeHandoffFile(cwd, handoff);
  // Rebuild under lock so concurrent creates never drop each other's pointers.
  withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
  return path;
}

export interface CreateOptions {
  summarizer?: HandoffSummarizer;
  /**
   * When true, `handoffLlm=on` config may request the LLM path (CLI always
   * passes this). Without a real `summarizer`, LLM requests fail honestly.
   */
  allowAutoLlm?: boolean;
}

/**
 * Create a handoff: deterministic by default.
 * `--llm` / config handoff-llm on requires an injected summarizer — never fakes model_calls.
 */
export async function createHandoff(
  cwd: string,
  input: CreateHandoffInput = {},
  opts: CreateOptions = {},
): Promise<CreateHandoffResult> {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ? assertValidHandoffId(input.id) : newHandoffId(new Date(now));

  if (input.id) {
    const existing = readHandoff(cwd, id);
    if (existing) {
      throw new Error(`handoff already exists: ${id}`);
    }
  }

  let draft = buildDeterministicDraft(cwd, input);

  const cfg = readHandoffConfig(cwd);
  const wantLlm = Boolean(input.llm) || Boolean(opts.allowAutoLlm && cfg.handoffLlm === "on");

  let generationMode: Handoff["generation"]["mode"] = "deterministic";
  let model_calls = 0;
  let cost_bearing = false;
  let warning: string | undefined;

  // Explicit field overrides: user supplied objective plus at least one non-empty
  // structured field (empty arrays from the CLI do not count).
  const hasExplicitBody =
    Boolean(input.objective?.trim()) &&
    (Boolean(input.done?.length) ||
      Boolean(input.pending?.length) ||
      Boolean(input.next_action?.trim()));

  if (wantLlm) {
    if (!opts.summarizer) {
      throw new LlmHandoffNotImplementedError();
    }
    generationMode = "llm";
    const result = await opts.summarizer(draft, input.focus);
    draft = enforceDraftBounds(result.draft);
    model_calls = Math.max(0, Math.floor(result.model_calls));
    // Truthful accounting: cost-bearing only when a model call actually ran.
    cost_bearing = model_calls > 0;
    warning = result.warning || (cost_bearing ? LLM_COST_WARNING : undefined);
    if (!cost_bearing) {
      warning =
        warning ||
        "LLM summarizer reported model_calls=0; result stored as non-cost-bearing.";
    }
  } else if (hasExplicitBody) {
    generationMode = "explicit";
  }

  const handoff: Handoff = {
    id,
    state: "active",
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
    created_at: now,
    updated_at: now,
    generation: {
      mode: generationMode,
      model_calls,
      cost_bearing,
      warning,
    },
  };

  // Final redaction pass on all string fields (defense in depth).
  redactHandoffInPlace(handoff);
  if (draftCharCount(handoff as unknown as Parameters<typeof draftCharCount>[0]) > HANDOFF_BOUNDS.maxPacketChars) {
    // Should be rare after enforceDraftBounds; shrink pending/done further.
    handoff.done = handoff.done.slice(0, 5);
    handoff.pending = handoff.pending.slice(0, 3);
    handoff.blockers = handoff.blockers.slice(0, 3);
  }

  const path = persistHandoff(cwd, handoff);
  return { handoff, path, cost_bearing, warning };
}

function redactHandoffInPlace(h: Handoff): void {
  h.objective = sanitizeHandoffText(h.objective);
  h.done = h.done.map(sanitizeHandoffText);
  h.pending = h.pending.map(sanitizeHandoffText);
  h.blockers = h.blockers.map(sanitizeHandoffText);
  h.files_touched = h.files_touched.map(sanitizeHandoffText);
  h.verification_status = sanitizeHandoffText(h.verification_status);
  h.next_action = sanitizeHandoffText(h.next_action);
  h.suggested_skills = h.suggested_skills.map(sanitizeHandoffText);
  if (h.focus) h.focus = sanitizeHandoffText(h.focus);
  h.references = h.references.map((r) => ({
    label: r.label ? sanitizeHandoffText(r.label) : undefined,
    path: r.path ? sanitizeHandoffText(r.path) : undefined,
    url: r.url ? sanitizeHandoffText(r.url) : undefined,
  }));
}

/** Read a handoff by id. Throws on invalid id; returns null if missing. */
export function readHandoff(cwd: string, id: string): Handoff | null {
  assertValidHandoffId(id);
  const p = handoffFilePath(cwd, id);
  const h = readJSON<Handoff | null>(p, null);
  if (!h || typeof h.id !== "string") return null;
  return h;
}

export interface ListHandoffsOptions {
  /** Include closed/archived (default: active only). */
  all?: boolean;
  state?: HandoffState;
}

/**
 * List handoffs. Default: active only, scanned from disk (not a fragile index).
 * Index is refreshed best-effort so pointers stay consistent for other readers.
 */
export function listHandoffs(cwd: string, opts: ListHandoffsOptions = {}): Handoff[] {
  const all = scanHandoffFiles(cwd);
  let filtered: Handoff[];
  if (opts.state) {
    filtered = all.filter((h) => h.state === opts.state);
  } else if (opts.all) {
    filtered = all;
  } else {
    filtered = all.filter((h) => h.state === "active");
    // Best-effort index repair (ignore lock contention).
    try {
      withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
    } catch {
      // list still returns scan results
    }
  }
  return filtered;
}

/** Active handoff pointers for context surfacing (id + sanitized objective). */
export function listHandoffPointers(cwd: string): HandoffPointer[] {
  return listHandoffs(cwd)
    .filter((h) => h.state === "active")
    .map(pointerOf);
}

function setState(cwd: string, id: string, state: HandoffState): Handoff {
  const h = readHandoff(cwd, id);
  if (!h) throw new Error(`handoff not found: ${id}`);
  h.state = state;
  h.updated_at = new Date().toISOString();
  writeHandoffFile(cwd, h);
  withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
  return h;
}

export function closeHandoff(cwd: string, id: string): Handoff {
  return setState(cwd, id, "closed");
}

export function archiveHandoff(cwd: string, id: string): Handoff {
  return setState(cwd, id, "archived");
}

export interface PruneOptions {
  /** Remove closed/archived older than this many days (default 30). Must be >= 0. */
  olderThanDays?: number;
}

/**
 * Remove stale closed/archived handoff files and repair the active index.
 * Never deletes active handoffs. Unparseable timestamps are kept (not deleted).
 */
export function pruneHandoffs(cwd: string, opts: PruneOptions = {}): { removed: string[]; kept: number } {
  const days = opts.olderThanDays ?? 30;
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("olderThanDays must be a non-negative number");
  }
  const cutoff = Date.now() - days * 86_400_000;
  const dir = handoffsDir(cwd);
  const removed: string[] = [];

  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "index.json") continue;
      const id = f.slice(0, -".json".length);
      try {
        assertValidHandoffId(id);
      } catch {
        continue;
      }
      const h = readJSON<Handoff | null>(join(dir, f), null);
      if (!h) continue;
      if (h.state === "active") continue;
      const updated = Date.parse(h.updated_at);
      // Keep corrupt timestamps rather than deleting unconditionally.
      if (!Number.isFinite(updated)) continue;
      if (updated < cutoff) {
        try {
          unlinkSync(join(dir, f));
          removed.push(id);
        } catch {
          // skip unremovable
        }
      }
    }
  }

  const idx = rebuildIndex(cwd);
  return { removed: removed.sort(), kept: idx.active.length };
}
