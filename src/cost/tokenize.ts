export function normalizeTokenInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * Lightweight local token estimate. It is intentionally deterministic and
 * dependency-free; USD reporting must label this as estimated unless a real
 * provider usage source is added later.
 */
export function countTokens(value: unknown): number {
  const text = normalizeTokenInput(value);
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
