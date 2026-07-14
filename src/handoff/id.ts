/**
 * Handoff ids are safe filename stems: alphanumerics, underscore, hyphen, dot.
 * Rejects path traversal (`..`, `/`, `\`), reserved names, and empty / oversized values.
 */
const HANDOFF_ID_RE = /^[\w.-]+$/;
const MAX_ID_LEN = 128;
/** Reserved so handoff files cannot collide with the active index / lock. */
const RESERVED_IDS = new Set(["index", "index.lock"]);

export function isValidHandoffId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LEN) return false;
  if (id === "." || id === ".." || id.includes("..")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  if (RESERVED_IDS.has(id) || RESERVED_IDS.has(id.toLowerCase())) return false;
  return HANDOFF_ID_RE.test(id);
}

/** Throws if `id` is not a safe handoff id (before any file I/O). */
export function assertValidHandoffId(id: string): string {
  if (!isValidHandoffId(id)) {
    throw new Error(`invalid handoff id: ${id}`);
  }
  return id;
}

/** Generate a unique-ish id: `ho-<base36time>-<rand>`. */
export function newHandoffId(now = new Date()): string {
  const t = now.getTime().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `ho-${t}-${r}`;
}
