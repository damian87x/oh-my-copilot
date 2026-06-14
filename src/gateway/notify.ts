/**
 * Outbound Slack notifier — Hermes-style. No daemon. No socket. Each call is
 * a stateless POST to Slack's REST API.
 *
 * Resolution model (mirrors apps/hermes-agent/tools/send_message_tool.py):
 *  1. Caller passes `target` OR we read `SLACK_HOME_CHANNEL` from env.
 *  2. If the resolved Slack ID is a user-id (U…), we call
 *     `conversations.open` once to get the corresponding D… IM channel.
 *  3. POST to `chat.postMessage` with the (D…/C…/G…) channel id.
 *
 * Retry: bounded exponential backoff on 429 (rate limit) and 5xx. Other Slack
 * errors return immediately with the typed reason code so callers (cron) can
 * record dropped payloads to a side log without hammering Slack.
 */
import { parseTarget, parseSlackRef, type SlackTarget } from "./target-parser.js";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_OPEN_URL = "https://slack.com/api/conversations.open";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export interface NotifyDeps {
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override fetch (tests). Defaults to global fetch. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch?: typeof fetch;
  /** Override sleep (tests bypass backoff). */
  sleep?: (ms: number) => Promise<void>;
}

export interface NotifyOptions {
  text: string;
  /** Explicit target. When omitted, falls back to `SLACK_HOME_CHANNEL`. */
  target?: string;
  /** Optional thread to reply in (overrides target's :thread_ts suffix). */
  threadTs?: string;
  /** Max total wait incl. retries. Default 10s. */
  timeoutMs?: number;
}

export type NotifyErrorCode =
  | "MISSING_TEXT"
  | "MISSING_TOKEN"
  | "MISSING_TARGET"
  | "BAD_TARGET"
  | "BAD_HOME_CHANNEL"
  | "OPEN_FAILED"
  | "POST_FAILED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK_ERROR";

export type NotifyResult =
  | {
      ok: true;
      channel: string;
      ts: string;
      /** True when we had to call conversations.open to map U… → D…. */
      openedIm: boolean;
    }
  | {
      ok: false;
      code: NotifyErrorCode;
      reason: string;
    };

/**
 * Send a Slack message. Library entry point — never throws. Returns a
 * structured result so callers (cron / `/slack send` skill / CLI) decide
 * how to surface or persist failures.
 */
export async function notify(
  opts: NotifyOptions,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const text = (opts.text ?? "").toString();
  if (!text.trim()) {
    return { ok: false, code: "MISSING_TEXT", reason: "text is empty" };
  }

  const token = (env.SLACK_BOT_TOKEN ?? "").trim();
  if (!token) {
    return { ok: false, code: "MISSING_TOKEN", reason: "SLACK_BOT_TOKEN is not set" };
  }

  // 1. Resolve target.
  let target: SlackTarget;
  if (opts.target && opts.target.trim()) {
    const parsed = parseTarget(opts.target);
    if (!parsed.ok) return { ok: false, code: "BAD_TARGET", reason: parsed.error };
    target = parsed.target;
  } else {
    const home = (env.SLACK_HOME_CHANNEL ?? "").trim();
    if (!home) {
      return {
        ok: false,
        code: "MISSING_TARGET",
        reason:
          "no --target and SLACK_HOME_CHANNEL is unset; set one via `omp env init` or pass --target slack:C0…",
      };
    }
    const parsed = parseSlackRef(home);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "BAD_HOME_CHANNEL",
        reason: `SLACK_HOME_CHANNEL=${home}: ${parsed.error}`,
      };
    }
    target = parsed.target;
  }

  // Validate an explicit --thread-ts the same way we validate :thread_ts
  // suffixes in the target string. Without this, a typo via the flag path
  // bypasses parser validation and Slack reports an opaque error at runtime.
  if (opts.threadTs && !/^[0-9]+\.[0-9]+$/.test(opts.threadTs)) {
    return {
      ok: false,
      code: "BAD_TARGET",
      reason: `threadTs "${opts.threadTs}" is not a Slack timestamp (expected digits.digits)`,
    };
  }

  // One absolute deadline for the whole notify call — shared across
  // conversations.open + chat.postMessage so a U-target send can't quietly
  // take 2× the documented budget.
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // 2. If user-id, resolve to a DM channel via conversations.open.
  let channelId = target.id;
  let openedIm = false;
  if (target.kind === "user") {
    const opened = await openIm(target.id, { token, doFetch, sleep, deadline });
    if (!opened.ok) return opened;
    channelId = opened.channel;
    openedIm = true;
  }

  // 3. Post.
  const threadTs = opts.threadTs ?? target.threadTs;
  return await postMessage({
    token,
    channel: channelId,
    text,
    threadTs,
    doFetch,
    sleep,
    openedIm,
    deadline,
  });
}

interface OpenImArgs {
  token: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Absolute Date.now() deadline shared by all calls in one notify(). */
  deadline: number;
}

async function openIm(
  userId: string,
  args: OpenImArgs,
): Promise<{ ok: true; channel: string } | (NotifyResult & { ok: false })> {
  const r = await callSlack({
    url: SLACK_OPEN_URL,
    body: { users: userId },
    ...args,
  });
  if (!r.ok) {
    if (r.code === "RATE_LIMITED" || r.code === "TIMEOUT" || r.code === "NETWORK_ERROR") {
      return r;
    }
    return { ok: false, code: "OPEN_FAILED", reason: r.reason };
  }
  const channel = (r.payload?.channel as { id?: string } | undefined)?.id;
  if (!channel) {
    return { ok: false, code: "OPEN_FAILED", reason: "conversations.open returned no channel.id" };
  }
  return { ok: true, channel };
}

interface PostMessageArgs extends OpenImArgs {
  channel: string;
  text: string;
  threadTs?: string;
  openedIm: boolean;
}

async function postMessage(args: PostMessageArgs): Promise<NotifyResult> {
  const body: Record<string, unknown> = {
    channel: args.channel,
    text: args.text,
  };
  if (args.threadTs) body.thread_ts = args.threadTs;

  const r = await callSlack({ url: SLACK_POST_URL, body, ...args });
  if (!r.ok) return r;
  const ts = (r.payload?.ts as string | undefined) ?? "";
  return { ok: true, channel: args.channel, ts, openedIm: args.openedIm };
}

interface CallArgs extends OpenImArgs {
  url: string;
  body: Record<string, unknown>;
}

interface CallOk {
  ok: true;
  payload: Record<string, unknown>;
}

type CallResult = CallOk | (NotifyResult & { ok: false });

/**
 * Single Slack API call with bounded retry. Treats 429 + 5xx as retryable
 * (exponential backoff bounded by `timeoutMs`). Slack-level `ok:false`
 * payloads return immediately as POST_FAILED — those are deterministic
 * (invalid token / channel_not_found / not_in_channel etc).
 */
async function callSlack(args: CallArgs): Promise<CallResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const remaining = args.deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, code: "TIMEOUT", reason: `gave up after deadline` };
    }

    let res: Response;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res = await args.doFetch(args.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${args.token}`,
        },
        body: JSON.stringify(args.body),
        signal: AbortSignal.timeout(Math.min(remaining, 5_000)),
      } as RequestInit);
    } catch (err) {
      const msg = redact(err instanceof Error ? err.message : String(err), args.token);
      if (/abort|timeout/i.test(msg)) {
        return { ok: false, code: "TIMEOUT", reason: msg };
      }
      // Network blip — try again if we have budget.
      const sleepMs = Math.min(backoffMs(attempt), Math.max(args.deadline - Date.now() - 50, 0));
      if (attempt < MAX_ATTEMPTS - 1 && sleepMs > 0) {
        await args.sleep(sleepMs);
        continue;
      }
      return { ok: false, code: "NETWORK_ERROR", reason: msg };
    }

    // 429 → wait per Retry-After header if present; otherwise exponential.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 1);
      const sleepBudget = Math.max(args.deadline - Date.now() - 100, 0);
      const sleepMs = Math.min(retryAfter * 1000, sleepBudget);
      if (attempt < MAX_ATTEMPTS - 1 && sleepMs >= 0 && sleepBudget > 0) {
        await args.sleep(sleepMs);
        continue;
      }
      return { ok: false, code: "RATE_LIMITED", reason: `429 after ${attempt + 1} attempt(s)` };
    }

    // 5xx → retry.
    if (res.status >= 500 && res.status < 600) {
      const sleepMs = Math.min(backoffMs(attempt), Math.max(args.deadline - Date.now() - 50, 0));
      if (attempt < MAX_ATTEMPTS - 1 && sleepMs > 0) {
        await args.sleep(sleepMs);
        continue;
      }
      return { ok: false, code: "POST_FAILED", reason: `slack ${res.status} after ${attempt + 1} attempt(s)` };
    }

    // Anything else: parse the body and dispatch on Slack's own ok flag.
    let payload: Record<string, unknown>;
    try {
      payload = (await res.json()) as Record<string, unknown>;
    } catch {
      return { ok: false, code: "POST_FAILED", reason: `slack ${res.status}: non-JSON response` };
    }
    if (payload.ok === true) return { ok: true, payload };

    // Slack's documented schema has `error` as a string, but proxies / WAFs /
    // wrong endpoints can return object / array / null. Coerce defensively
    // before redacting — the public contract is never-throws.
    const rawError = (payload as Record<string, unknown>).error;
    const reasonRaw = coerceErrorReason(rawError);
    const reason = redact(reasonRaw, args.token);
    // Slack uses `ratelimited` (no underscore) for rate-limit errors when not
    // surfaced as HTTP 429. Treat as RATE_LIMITED so callers can back off.
    if (reasonRaw === "ratelimited" || reasonRaw === "rate_limited") {
      return { ok: false, code: "RATE_LIMITED", reason };
    }
    return { ok: false, code: "POST_FAILED", reason };
  }
  return { ok: false, code: "POST_FAILED", reason: "exhausted retries" };
}

/**
 * Coerce a Slack error field of unknown shape to a string. Slack documents
 * `error: string`, but proxies/WAFs/mis-pointed endpoints can return objects,
 * arrays, or null. We must NOT throw — the caller's never-throws guarantee
 * is part of the public contract.
 */
function coerceErrorReason(raw: unknown): string {
  if (raw == null) return "slack returned ok:false";
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  try {
    return JSON.stringify(raw);
  } catch {
    return "slack returned ok:false (unserializable error field)";
  }
}

/**
 * Strip the bot token (and Bearer-prefix patterns) from any string that's
 * about to be returned in `reason` or logged. Cheap belt-and-braces guard:
 * Slack itself never echoes our token, but a fetch / abort / DNS error could
 * contain the request URL or headers depending on the runtime, and any such
 * leak would land in the schedule runner's stderr log.
 */
function redact(s: string, token: string): string {
  let out = s;
  if (token) {
    // Replace literal token wherever it appears.
    out = out.split(token).join("[REDACTED]");
  }
  // Strip generic Bearer-token patterns that some fetch errors include.
  out = out.replace(/Bearer\s+[A-Za-z0-9-._~+/]+=*/g, "Bearer [REDACTED]");
  // Strip Slack-format tokens that might appear in payloads. Covers:
  //   xox[a/b/e/p/r/s]- (legacy access / bot / refresh / user / config / signing)
  //   xapp-              (app-level tokens — what `omp gateway serve` uses)
  out = out.replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "[REDACTED]");
  out = out.replace(/xapp-[A-Za-z0-9-]+/gi, "[REDACTED]");
  return out;
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1000ms — bounded so a misbehaving Slack doesn't stall cron forever.
  return Math.min(250 * 2 ** attempt, 1_000);
}
