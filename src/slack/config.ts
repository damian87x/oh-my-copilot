/**
 * Slack bridge configuration. Reads tokens + policy from env (mirroring the
 * omp env-config pattern), with optional overrides for tests/flags.
 *
 * Tokens (both required):
 * - SLACK_BOT_TOKEN  (xoxb-…)  — bot user OAuth token
 * - SLACK_APP_TOKEN  (xapp-…)  — app-level token with `connections:write` (Socket Mode)
 *
 * Policy (optional):
 * - SLACK_ALLOWED_USERS  csv of user IDs; `*` or unset/empty = allow everyone
 * - SLACK_REQUIRE_MENTION  "true"/"false" (default true) — require @mention in channels
 * - COPILOT_TMUX_SESSION  passthrough to comms session resolution
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** [] means allow all; ["*"] also means allow all. */
  allowedUsers: string[];
  /** require an @mention to respond in channels (DMs always respond). */
  requireMention: boolean;
  /** explicit Copilot tmux session name, if set. */
  sessionEnv?: string;
}

export interface SlackConfigOverrides {
  botToken?: string;
  appToken?: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Load + validate Slack config. Throws a clear error if a token is missing. */
export function loadSlackConfig(overrides: SlackConfigOverrides = {}): SlackConfig {
  const botToken = (overrides.botToken ?? process.env.SLACK_BOT_TOKEN ?? "").trim();
  const appToken = (overrides.appToken ?? process.env.SLACK_APP_TOKEN ?? "").trim();
  if (!botToken) {
    throw new Error("SLACK_BOT_TOKEN is required (xoxb-… bot token)");
  }
  if (!botToken.startsWith("xoxb-")) {
    throw new Error("SLACK_BOT_TOKEN looks wrong — expected a bot token starting with 'xoxb-'");
  }
  if (!appToken) {
    throw new Error("SLACK_APP_TOKEN is required (xapp-… app-level token with connections:write)");
  }
  if (!appToken.startsWith("xapp-")) {
    throw new Error("SLACK_APP_TOKEN looks wrong — expected an app-level token starting with 'xapp-'");
  }
  return {
    botToken,
    appToken,
    allowedUsers: parseCsv(process.env.SLACK_ALLOWED_USERS),
    requireMention: parseBool(process.env.SLACK_REQUIRE_MENTION, true),
    sessionEnv: process.env.COPILOT_TMUX_SESSION,
  };
}
