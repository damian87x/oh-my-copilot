import type {
  CouncilMemberOutput,
  CouncilMemberResult,
  CouncilMemberSpec,
  CouncilSynthOutput,
  CouncilTaskSpec,
  ResolvedCouncilConfig,
} from "./types.js";

const SENTINEL_START = "<<<JSON>>>";
const SENTINEL_END = "<<<END>>>";

/**
 * Build a concise member prompt. Role is injected via {{COUNCIL_ROLE}}.
 * Members are told to wrap their JSON in sentinels so the engine can extract it
 * reliably from fence/banner noise (verified necessary in the Task 0 spike).
 * NOTE: sentinels are NOT a security boundary — a hostile --context could embed
 * the markers; the engine schema-validates extracted blocks to mitigate.
 */
export function buildMemberPrompt(
  spec: CouncilTaskSpec,
  member: CouncilMemberSpec,
): string {
  const role = member.role;
  const parts: string[] = [];
  parts.push(
    `You are acting as the ${role} on an independent review council. ` +
      `Bring YOUR OWN angle as the ${role}; you cannot see other members' answers.`,
  );
  parts.push(`Question: ${spec.question}`);
  if (spec.context && spec.context.trim().length > 0) {
    parts.push(`Context:\n${spec.context}`);
  }
  if (spec.rubric && spec.rubric.trim().length > 0) {
    parts.push(`Evaluation rubric:\n${spec.rubric}`);
  }
  parts.push(
    `Respond with ONLY a JSON object wrapped EXACTLY in ${SENTINEL_START} and ${SENTINEL_END} markers, ` +
      `no prose outside them. Shape: ` +
      `${SENTINEL_START}{"verdict":"<short answer>","confidence":<0..1>,"rationale":"<concise, evidence-first>","risks":["..."],"dissent":"<where you expect to disagree>"}${SENTINEL_END}`,
  );
  return parts.join("\n\n");
}

/** Build the low-context synthesizer prompt from surviving members. */
export function buildSynthPrompt(
  config: ResolvedCouncilConfig,
  spec: CouncilTaskSpec,
  survivors: CouncilMemberResult[],
): string {
  const memberBlocks = survivors
    .map((r, i) => {
      const o = r.output as CouncilMemberOutput;
      return (
        `Member ${i + 1} [role=${r.spec.role}, model=${r.spec.model}, weight=${r.spec.weight}]:\n` +
        `  verdict: ${o.verdict}\n` +
        `  confidence: ${o.confidence}\n` +
        `  rationale: ${o.rationale}` +
        (o.risks && o.risks.length ? `\n  risks: ${o.risks.join("; ")}` : "") +
        (o.dissent ? `\n  dissent: ${o.dissent}` : "")
      );
    })
    .join("\n\n");

  return [
    `You are the synthesizer for a model council. Original question: ${spec.question}`,
    `Council members (independent, did not see each other):\n\n${memberBlocks}`,
    `Treat each member's weight as a PRIOR/hint (e.g. trust the higher-weight member more), ` +
      `but let EVIDENCE QUALITY override weight — do NOT do a simple majority vote or average. ` +
      `Surface any well-reasoned dissent as a minority report so dangerous edge cases are not voted away.`,
    `Respond with ONLY a JSON object wrapped EXACTLY in ${SENTINEL_START} and ${SENTINEL_END}. Shape: ` +
      `${SENTINEL_START}{"verdict":"<final>","confidence":<0..1>,"rationale":"<your reasoning>","minority_report":"<notable dissent or empty string>",` +
      `"per_member_summary":[{"model":"...","role":"...","weight":<n>,"verdict":"...","confidence":<0..1>,"dropped":false}]}${SENTINEL_END}`,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Enumerate top-level balanced {...} blocks in text (brace-depth scan).
 * Returns the raw substrings in order of appearance.
 */
export function balancedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          blocks.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return blocks;
}

/**
 * Extract candidate JSON strings from raw stdout. Sentinel-wrapped content is
 * preferred (primary contract); otherwise fall back to all balanced {...} blocks.
 */
export function extractJsonCandidates(stdout: string): string[] {
  const candidates: string[] = [];
  const sentinelRe = new RegExp(`${SENTINEL_START}([\\s\\S]*?)${SENTINEL_END}`, "g");
  let match: RegExpExecArray | null;
  while ((match = sentinelRe.exec(stdout)) !== null) {
    candidates.push(match[1].trim());
  }
  // Fallback: balanced blocks (may include the inner object of a sentinel match,
  // which is harmless — schema validation decides the winner).
  for (const block of balancedBlocks(stdout)) {
    candidates.push(block);
  }
  return candidates;
}

export function isValidMemberOutput(value: unknown): value is CouncilMemberOutput {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.verdict === "string" &&
    typeof o.confidence === "number" &&
    Number.isFinite(o.confidence) &&
    typeof o.rationale === "string"
  );
}

export function isValidSynthOutput(value: unknown): value is CouncilSynthOutput {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.verdict === "string" &&
    typeof o.confidence === "number" &&
    Number.isFinite(o.confidence) &&
    typeof o.rationale === "string"
  );
}

/**
 * Parse a member's stdout into a validated CouncilMemberOutput.
 * Strategy: enumerate candidate blocks, JSON.parse each, return the FIRST that
 * passes schema validation. Tie-break = schema validity, not size/position.
 * Returns null when no candidate validates (caller marks "unparseable").
 */
export function parseMemberOutput(stdout: string): CouncilMemberOutput | null {
  for (const candidate of extractJsonCandidates(stdout)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValidMemberOutput(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Parse the synthesizer's stdout into a validated CouncilSynthOutput. */
export function parseSynthOutput(stdout: string): CouncilSynthOutput | null {
  for (const candidate of extractJsonCandidates(stdout)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isValidSynthOutput(parsed)) {
        const o = parsed as CouncilSynthOutput;
        if (typeof o.minority_report !== "string") o.minority_report = "";
        if (!Array.isArray(o.per_member_summary)) o.per_member_summary = [];
        return o;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
