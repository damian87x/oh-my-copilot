/**
 * Parse outbound notification targets.
 *
 * Target grammar (Hermes-mirror — see apps/hermes-agent/tools/send_message_tool.py:21-46):
 *
 *   "<platform>:<ref>"   → explicit per-call target
 *
 * Bare-platform fallback (`<platform>` with no `:<ref>`) is NOT implemented in
 * this parser. The notify() caller layer handles the "no target → env default"
 * decision by passing undefined/empty as the target and reading
 * `SLACK_HOME_CHANNEL` directly — it never calls `parseTarget("slack")`.
 *
 * For slice 1 the only platform is "slack". <ref> for slack is a 9+ char
 * uppercase alphanumeric ID prefixed with one of:
 *   C — public channel
 *   G — private channel ("group")
 *   D — direct message conversation
 *   U — user (must be conversations.open'd to a D… before chat.postMessage;
 *       the caller is responsible for that resolution)
 *
 * Optional thread suffix: "<ref>:<thread_ts>" pins the post to an existing
 * thread in that conversation. Not all kinds support threading sensibly, but
 * the parser accepts it for any non-user kind.
 *
 * NOT supported in this pass: user IDs with embedded thread suffixes (no
 * coherent meaning until U→D resolution); Hermes-style multi-platform
 * regexes for telegram/discord/feishu (those land in slice 2+).
 */

/** Slack ID after the `slack:` prefix. */
export const SLACK_ID_RE = /^([CGDU])([A-Z0-9]{8,})$/;

/**
 * Slack ID + optional thread suffix `:<thread_ts>`.
 *
 * `thread_ts` must look like Slack's canonical message timestamp shape
 * (`<seconds>.<microseconds>` — digits-only). Anything else is rejected here
 * so the CLI / schedule add validators catch typos before they reach Slack.
 */
export const SLACK_TARGET_RE =
  /^([CGD])([A-Z0-9]{8,})(?::([0-9]+\.[0-9]+))?$|^(U)([A-Z0-9]{8,})$/;

export type SlackTargetKind = "channel" | "group" | "dm" | "user";

export interface SlackTarget {
  platform: "slack";
  kind: SlackTargetKind;
  /**
   * The raw Slack ID (`C…`/`G…`/`D…`/`U…`). For user targets, the caller
   * must resolve to a D-ID via conversations.open before posting.
   */
  id: string;
  /** Optional `thread_ts` for threaded posts. */
  threadTs?: string;
}

export type ParsedTarget = SlackTarget;

export interface ParseError {
  ok: false;
  error: string;
}

export type ParseResult = { ok: true; target: ParsedTarget } | ParseError;

const SLACK_KIND: Record<string, SlackTargetKind> = {
  C: "channel",
  G: "group",
  D: "dm",
  U: "user",
};

/**
 * Parse a target string of the form `<platform>:<ref>`. Returns either a
 * structured target or a friendly error. Pure — no I/O.
 */
export function parseTarget(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "target is empty" };

  const colon = trimmed.indexOf(":");
  if (colon === -1) {
    return {
      ok: false,
      error: `target "${trimmed}" missing ":<ref>"; e.g. slack:C0BOQV5434G or slack:U0123ABCD`,
    };
  }

  const platform = trimmed.slice(0, colon).trim().toLowerCase();
  const ref = trimmed.slice(colon + 1).trim();

  if (platform !== "slack") {
    return { ok: false, error: `unsupported platform "${platform}"; only "slack" today` };
  }
  if (!ref) {
    return { ok: false, error: `slack target missing ID; e.g. slack:C0BOQV5434G` };
  }
  return parseSlackRef(ref);
}

/**
 * Parse just the slack-side `<ref>` (the part after `slack:`). Useful when a
 * caller has already established platform context (e.g. `SLACK_HOME_CHANNEL`
 * is set without a platform prefix).
 */
export function parseSlackRef(ref: string): ParseResult {
  const m = ref.match(SLACK_TARGET_RE);
  if (!m) {
    return {
      ok: false,
      error: `not a Slack ID: "${ref}". Expected C…/G…/D…/U… plus 8+ uppercase alphanumeric chars (optional :thread_ts for channels)`,
    };
  }

  // Two alternatives in the regex; pick whichever matched.
  const prefix = (m[1] ?? m[4]) as keyof typeof SLACK_KIND;
  const body = (m[2] ?? m[5]) as string;
  const threadTs = m[3];

  return {
    ok: true,
    target: {
      platform: "slack",
      kind: SLACK_KIND[prefix],
      id: `${prefix}${body}`,
      threadTs,
    },
  };
}

/**
 * Best-effort check for "looks like a Slack ID" without committing to a
 * specific kind — used by config validators to nudge users about typos
 * before any network call.
 */
export function looksLikeSlackId(value: string): boolean {
  return SLACK_ID_RE.test(value.trim());
}
