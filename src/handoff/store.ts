import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock, forceReleaseStaleLock } from "../schedule/lock.js";
import { atomicWrite, ensureDir } from "../utils/fs.js";
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
import { parseHandoffMarkdown, serializeHandoffMarkdown } from "./markdown.js";
import { handoffFilePath, handoffIndexPath, handoffLegacyJsonPath, handoffsDir } from "./paths.js";
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

function indexLockPath(cwd: string): string {
  return join(handoffsDir(cwd), "index.lock");
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait: create/close are short critical sections
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
  atomicWrite(p, serializeHandoffMarkdown(handoff));
  // Drop legacy JSON twin if present so list does not double-count.
  const legacy = handoffLegacyJsonPath(cwd, handoff.id);
  if (existsSync(legacy)) {
    try {
      unlinkSync(legacy);
    } catch {
      // best-effort
    }
  }
  return resolve(p);
}

function loadHandoffFromFile(filePath: string): Handoff | null {
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, "utf8");
    if (filePath.endsWith(".md")) {
      return parseHandoffMarkdown(text);
    }
    const data = JSON.parse(text) as Handoff;
    return data && typeof data.id === "string" ? data : null;
  } catch {
    return null;
  }
}

function pointerOf(h: Handoff): HandoffPointer {
  return {
    id: h.id,
    objective: sanitizeForInstructions(h.objective).slice(0, 200),
    updated_at: h.updated_at,
  };
}

/** Scan disk for handoff files (source of truth). Prefer .md over legacy .json. */
function scanHandoffFiles(cwd: string): Handoff[] {
  const dir = handoffsDir(cwd);
  if (!existsSync(dir)) return [];
  const byId = new Map<string, Handoff>();

  for (const f of readdirSync(dir)) {
    if (f === "index.json" || f.endsWith(".lock")) continue;
    const isMd = f.endsWith(".md");
    const isJson = f.endsWith(".json");
    if (!isMd && !isJson) continue;
    const id = f.replace(/\.md$|\.json$/, "");
    try {
      assertValidHandoffId(id);
    } catch {
      continue;
    }
    if (isJson && byId.has(id)) continue;
    if (isJson && existsSync(join(dir, `${id}.md`))) continue;

    const h = loadHandoffFromFile(join(dir, f));
    if (!h || typeof h.id !== "string") continue;
    byId.set(id, h);
  }

  return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Recompute active index from on-disk handoff files. */
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
  withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
  return path;
}

export interface CreateOptions {
  summarizer?: HandoffSummarizer;
  allowAutoLlm?: boolean;
}

/**
 * Create a handoff: deterministic by default.
 * Writes `.omp/handoffs/<id>.md`. `--llm` requires an injected summarizer.
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

  redactHandoffInPlace(handoff);
  if (
    draftCharCount(handoff as unknown as Parameters<typeof draftCharCount>[0]) >
    HANDOFF_BOUNDS.maxPacketChars
  ) {
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

/** Read a handoff by id. Prefers `.md`, falls back to legacy `.json`. */
export function readHandoff(cwd: string, id: string): Handoff | null {
  assertValidHandoffId(id);
  const md = loadHandoffFromFile(handoffFilePath(cwd, id));
  if (md) return md;
  return loadHandoffFromFile(handoffLegacyJsonPath(cwd, id));
}

export interface ListHandoffsOptions {
  all?: boolean;
  state?: HandoffState;
}

/** List handoffs. Default: active only, scanned from disk. */
export function listHandoffs(cwd: string, opts: ListHandoffsOptions = {}): Handoff[] {
  const all = scanHandoffFiles(cwd);
  let filtered: Handoff[];
  if (opts.state) {
    filtered = all.filter((h) => h.state === opts.state);
  } else if (opts.all) {
    filtered = all;
  } else {
    filtered = all.filter((h) => h.state === "active");
    try {
      withIndexLock(cwd, () => rebuildIndexUnlocked(cwd));
    } catch {
      // list still returns scan results
    }
  }
  return filtered;
}

/** Active handoff pointers for context surfacing. */
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
  olderThanDays?: number;
}

/**
 * Remove stale closed/archived handoff files and repair the active index.
 * Never deletes active handoffs.
 */
export function pruneHandoffs(
  cwd: string,
  opts: PruneOptions = {},
): { removed: string[]; kept: number } {
  const days = opts.olderThanDays ?? 30;
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("olderThanDays must be a non-negative number");
  }
  const cutoff = Date.now() - days * 86_400_000;
  const dir = handoffsDir(cwd);
  const removed: string[] = [];

  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f === "index.json" || f.endsWith(".lock")) continue;
      if (!f.endsWith(".md") && !f.endsWith(".json")) continue;
      const id = f.replace(/\.md$|\.json$/, "");
      try {
        assertValidHandoffId(id);
      } catch {
        continue;
      }
      const h = loadHandoffFromFile(join(dir, f));
      if (!h) continue;
      if (h.state === "active") continue;
      const updated = Date.parse(h.updated_at);
      if (!Number.isFinite(updated)) continue;
      if (updated < cutoff) {
        try {
          unlinkSync(join(dir, f));
          if (!removed.includes(id)) removed.push(id);
        } catch {
          // skip unremovable
        }
      }
    }
  }

  const idx = rebuildIndex(cwd);
  return { removed: removed.sort(), kept: idx.active.length };
}
