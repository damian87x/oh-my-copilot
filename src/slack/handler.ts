/**
 * Pure, testable core of the Slack → Copilot bridge. NO Slack/Bolt import here
 * so the decision logic can be unit-tested with injected fakes.
 *
 * Mirrors a lean subset of Hermes' Slack behavioral contract:
 * - DMs always respond; channels respond only on @mention (unless requireMention=false).
 * - Unauthorized users (not in the allowlist) are silently ignored.
 * - The bot's own `<@BOT>` mention is stripped from the text before forwarding.
 * - Resolution / Copilot errors come back as friendly Slack replies (never silent failure
 *   of a request we accepted).
 */
import type { ResolveSessionResult } from "../comms/resolve-session.js";
import type { AskResult } from "../comms/index.js";

export interface SlackMessageInput {
  text: string;
  userId?: string;
  channelType: "im" | "channel";
  /** true when the bot was @mentioned (channel messages) */
  isMention: boolean;
  /** thread to reply in (event.thread_ts ?? event.ts) */
  threadTs?: string;
  /** bot's own user id, for stripping the mention token */
  botUserId?: string;
}

export interface SlackHandlerDeps {
  resolve: (opts: { flag?: string; env?: string }) => ResolveSessionResult;
  ask: (session: string, text: string) => Promise<AskResult>;
  /** ["*"] = allow all; empty/unset denies all. */
  allowedUsers?: string[] | null;
  /** require @mention in channels (default true). */
  requireMention?: boolean;
  /** COPILOT_TMUX_SESSION passthrough for resolution. */
  sessionEnv?: string;
}

export interface SlackReply {
  /** text to post back, or null to stay silent. */
  reply: string | null;
  /** thread to reply in. */
  threadTs?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Allowlist check: only an explicit "*" allows everyone. */
export function isUserAllowed(userId: string | undefined, allowed?: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return false;
  if (allowed.includes("*")) return true;
  return userId != null && allowed.includes(userId);
}

/** Strip a `<@BOTID>` mention (and tidy whitespace) from message text. */
export function stripMention(text: string, botUserId?: string): string {
  let out = text ?? "";
  if (botUserId) {
    // Literal replace (no RegExp) — botUserId is external; avoid regex injection.
    out = out.split(`<@${botUserId}>`).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

export async function handleSlackMessage(
  input: SlackMessageInput,
  deps: SlackHandlerDeps,
): Promise<SlackReply> {
  const threadTs = input.threadTs;

  // 1. Authorization — silently ignore non-allowlisted users.
  if (!isUserAllowed(input.userId, deps.allowedUsers)) {
    return { reply: null, threadTs };
  }

  // 2. Respond gate — DMs always; channels only on @mention (unless disabled).
  const requireMention = deps.requireMention ?? true;
  if (input.channelType === "channel" && requireMention && !input.isMention) {
    return { reply: null, threadTs };
  }

  // 3. Clean the text.
  const text = stripMention(input.text, input.botUserId);
  if (!text) {
    return { reply: null, threadTs };
  }

  // 4. Resolve the Copilot session. A request we accepted must never reject
  //    silently — turn thrown errors into a friendly reply.
  let resolved: ResolveSessionResult;
  try {
    resolved = deps.resolve({ env: deps.sessionEnv });
  } catch (err) {
    return { reply: `:warning: could not resolve copilot session: ${errMsg(err)}`, threadTs };
  }
  if (!resolved.ok) {
    return { reply: `:warning: ${resolved.error}`, threadTs };
  }

  // 5. Ask Copilot.
  let result: AskResult;
  try {
    result = await deps.ask(resolved.session, text);
  } catch (err) {
    return { reply: `:warning: copilot request failed: ${errMsg(err)}`, threadTs };
  }
  if (!result.ok) {
    return { reply: `:warning: ${result.error ?? "copilot error"}`, threadTs };
  }
  if (result.timedOut) {
    const partial = (result.text ?? "").trim();
    const note = ":hourglass: Copilot is still working — ask again in a moment.";
    return { reply: partial ? `${note}\n\n${partial}` : note, threadTs };
  }
  const reply = (result.text ?? "").trim() || "_(no output)_";
  return { reply, threadTs };
}
