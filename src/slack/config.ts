/**
 * Slack bridge configuration. Reads tokens + policy from env (mirroring the
 * omp env-config pattern), with optional overrides for tests/flags.
 *
 * Tokens (both required):
 * - SLACK_BOT_TOKEN  (xoxb-…)  — bot user OAuth token
 * - SLACK_APP_TOKEN  (xapp-…)  — app-level token with `connections:write` (Socket Mode)
 *
 * Policy (required):
 * - SLACK_ALLOWED_USERS  csv of user IDs; `*` = explicit allow everyone opt-in
 * - SLACK_REQUIRE_MENTION  "true"/"false" (default true) — require @mention in channels
 * - COPILOT_TMUX_SESSION  passthrough to comms session resolution
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Non-empty; ["*"] means explicit allow all. */
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

export const SLACK_ALLOWED_USERS_REQUIRED_MESSAGE =
  "SLACK_ALLOWED_USERS is required. Set it to a comma-separated Slack user ID allowlist, or set SLACK_ALLOWED_USERS=* to explicitly allow all Slack users.";

export function ensureSlackAllowedUsersConfigured(allowedUsers: readonly string[]): void {
  if (allowedUsers.length === 0) {
    throw new Error(SLACK_ALLOWED_USERS_REQUIRED_MESSAGE);
  }
}

export function isSlackAllowAll(allowedUsers: readonly string[]): boolean {
  return allowedUsers.includes("*");
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

/**
 * Load + validate Slack config. Throws a clear error if a token is missing.
 * `env` defaults to process.env; tests can pass a custom map.
 */
export function loadSlackConfig(
  overrides: SlackConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): SlackConfig {
  const botToken = (overrides.botToken ?? env.SLACK_BOT_TOKEN ?? "").trim();
  const appToken = (overrides.appToken ?? env.SLACK_APP_TOKEN ?? "").trim();
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
  const allowedUsers = parseCsv(env.SLACK_ALLOWED_USERS);
  ensureSlackAllowedUsersConfigured(allowedUsers);
  return {
    botToken,
    appToken,
    allowedUsers,
    requireMention: parseBool(env.SLACK_REQUIRE_MENTION, true),
    sessionEnv: env.COPILOT_TMUX_SESSION,
  };
}
