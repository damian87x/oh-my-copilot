/**
 * Redact secret-like substrings and strip managed-context markers so handoffs
 * never persist credentials or poison copilot-instructions sentinels.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[=:]\s*\S+/gi,
];

const MARKER_RE = /<!--\s*omp:memory:(?:start|end)\s*-->/gi;

/** Replace credential-like tokens with [REDACTED]. */
export function redactSecrets(value: string): string {
  let out = String(value ?? "");
  for (const re of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls.
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/**
 * Safe for injection into managed instructions: redact secrets, drop marker
 * sentinels, collapse newlines.
 */
export function sanitizeForInstructions(value: string): string {
  return redactSecrets(value)
    .replace(MARKER_RE, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

/** Redact + strip markers for stored handoff text fields. */
export function sanitizeHandoffText(value: string): string {
  return redactSecrets(value).replace(MARKER_RE, "[marker-removed]").trim();
}
