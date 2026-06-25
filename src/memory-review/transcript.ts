import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Copilot writes a per-session event log to
// ~/.copilot/session-state/<uuid>/events.jsonl. The format is internal to
// Copilot and undocumented, so we parse it defensively: line-by-line, skipping
// anything unparseable, and degrade to an empty transcript rather than throwing.

export interface TranscriptMessage {
  role: string;
  text: string;
}

export interface ReadTranscriptOptions {
  // Override the session-state base (defaults to ~/.copilot/session-state) so
  // tests point at a fixture without touching the real home dir.
  sessionStateDir?: string;
  // Raw-bytes safety cap (OOM guard for pathological files). Generous by default
  // so real sessions are read in full — events.jsonl is bloated by tool output,
  // so a small byte cap would discard the actual conversation.
  maxBytes?: number;
  // Keep only the most recent N parsed messages. Bounds the review prompt by
  // CONVERSATION CONTENT (not raw bytes), so a long session contributes a
  // representative window instead of a tail sliver eaten by tool-output events.
  maxMessages?: number;
}

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// Parsed conversation is sparse (~10-15 tokens/msg; tool outputs dropped), so a
// generous window captures realistic long sessions in full while still bounding
// pathological ones. 200 covers observed real sessions (~178 msgs) end-to-end.
export const DEFAULT_MAX_MESSAGES = 200;

// Session ids are UUID-like (Copilot uses them as the session-state dir name).
// Validate before joining into a path so a crafted id can't traverse out of the
// session-state root (e.g. "../../etc").
export function isValidSessionId(uuid: string): boolean {
  return (
    typeof uuid === "string" &&
    /^[A-Za-z0-9._-]+$/.test(uuid) &&
    !uuid.includes("..") &&
    /[A-Za-z0-9]/.test(uuid) // reject dot/dash-only ids (e.g. ".") that resolve to the base dir
  );
}

export function sessionEventsPath(uuid: string, base?: string): string {
  const root = base ?? join(homedir(), ".copilot", "session-state");
  return join(root, uuid, "events.jsonl");
}

/** Newest session-state dir by mtime — used when the wrapper triggers a review
 *  post-exit and doesn't know the just-finished session's UUID. */
export function latestSessionId(base?: string): string | null {
  const root = base ?? join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return null;
  let best: string | null = null;
  let bestMtime = -1;
  for (const name of readdirSync(root)) {
    try {
      const st = statSync(join(root, name));
      if (st.isDirectory() && st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = name;
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return best;
}

/** All session dir names under the session-state base (for before/after diff). */
export function listSessionIds(base?: string): string[] {
  const root = base ?? join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The session that appeared since `before` — i.e. the one the just-finished
 *  headless `copilot -p` run created. Returns null if none is new, so the
 *  wrapper SKIPS rather than guessing the wrong session. */
export function newestSessionSince(before: string[], base?: string): string | null {
  const seen = new Set(before);
  const fresh = listSessionIds(base).filter((id) => !seen.has(id));
  if (fresh.length === 0) return null;
  if (fresh.length === 1) return fresh[0];
  const root = base ?? join(homedir(), ".copilot", "session-state");
  let best: string | null = null;
  let bestMtime = -1;
  for (const id of fresh) {
    try {
      const m = statSync(join(root, id)).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = id;
      }
    } catch {
      // skip unreadable
    }
  }
  return best;
}

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Summarize an assistant turn's tool calls. In agentic sessions most turns
// have empty `content` and do their work via `toolRequests`; without this they
// would be dropped — making a substantive session look "too short" and starving
// the reviewer of what the agent actually did. Format: "name: <intent|command>".
function summarizeToolRequests(toolRequests: unknown): string {
  if (!Array.isArray(toolRequests) || toolRequests.length === 0) return "";
  const parts: string[] = [];
  for (const t of toolRequests) {
    if (!t || typeof t !== "object") continue;
    const tr = t as { name?: unknown; intentionSummary?: unknown; arguments?: unknown };
    const name = typeof tr.name === "string" ? tr.name : "tool";
    const args = tr.arguments && typeof tr.arguments === "object" ? (tr.arguments as Record<string, unknown>) : {};
    const detail =
      (typeof tr.intentionSummary === "string" && tr.intentionSummary.trim()) ||
      (typeof args.description === "string" && args.description.trim()) ||
      (typeof args.command === "string" && args.command.trim()) ||
      "";
    parts.push(detail ? `${name}: ${detail}` : name);
  }
  return parts.length ? `(tools: ${parts.join(", ")})` : "";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function parseTranscript(raw: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      obj = parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      continue; // partial line (tail boundary) or non-JSON — skip
    }
    if (!obj) continue;

    // Real Copilot shape: {"type":"user.message","data":{"content":...,"role":...}}.
    // Only "*.message" events carry conversation text; every other event type
    // (session.*, assistant.turn_*, tool.*, hook.*) is skipped. Fall back to a
    // generic {role, content}/{message:{content}} shape for other producers.
    const type = typeof obj.type === "string" ? obj.type : "";
    const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>;

    let role: string;
    let content: unknown;
    let toolSummary = "";
    if (type.endsWith(".message")) {
      role = typeof data.role === "string" ? data.role : type.slice(0, -".message".length);
      content = data.content;
      // Assistant turns that act via tools carry the work in toolRequests, not
      // content — fold a summary in so the turn counts and the reviewer sees it.
      if (role === "assistant") toolSummary = summarizeToolRequests(data.toolRequests);
    } else if (type) {
      continue; // a typed event that is not a message — no conversation text
    } else {
      const message = (obj.message ?? {}) as Record<string, unknown>;
      role = String(obj.role ?? message.role ?? "unknown");
      content = message.content ?? obj.content ?? obj.text;
    }

    // Skip the system prompt — it's boilerplate, huge, and not user knowledge.
    if (role === "system") continue;

    const base = extractText(content).trim();
    const text = [base, toolSummary].filter(Boolean).join("\n");
    if (text) {
      messages.push({ role, text });
    }
  }
  return messages;
}

export function readSessionTranscript(
  uuid: string,
  options: ReadTranscriptOptions = {},
): TranscriptMessage[] {
  if (!isValidSessionId(uuid)) return [];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const path = sessionEventsPath(uuid, options.sessionStateDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readTail(path, maxBytes);
  } catch {
    return [];
  }
  const all = parseTranscript(raw);
  // Window to the most recent maxMessages so the review prompt stays bounded by
  // conversation length regardless of how long the session ran.
  return all.length > maxMessages ? all.slice(all.length - maxMessages) : all;
}
