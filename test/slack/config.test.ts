import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadSlackConfig } from "../../src/slack/config.js";

const KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USERS",
  "SLACK_REQUIRE_MENTION",
  "COPILOT_TMUX_SESSION",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadSlackConfig", () => {
  it("throws a clear error when the bot token is missing", () => {
    process.env.SLACK_APP_TOKEN = "xapp-x";
    expect(() => loadSlackConfig()).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("throws a clear error when the app token is missing", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    expect(() => loadSlackConfig()).toThrow(/SLACK_APP_TOKEN/);
  });

  it("accepts overrides in place of env tokens", () => {
    process.env.SLACK_ALLOWED_USERS = "*";
    const cfg = loadSlackConfig({ botToken: "xoxb-o", appToken: "xapp-o" });
    expect(cfg.botToken).toBe("xoxb-o");
    expect(cfg.appToken).toBe("xapp-o");
  });

  it("throws a clear error when the allowed users allowlist is missing or empty", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    process.env.SLACK_APP_TOKEN = "xapp-x";
    expect(() => loadSlackConfig()).toThrow(/SLACK_ALLOWED_USERS=.*\*/);
    process.env.SLACK_ALLOWED_USERS = " , ";
    expect(() => loadSlackConfig()).toThrow(/SLACK_ALLOWED_USERS=.*\*/);
  });

  it("accepts explicit wildcard allow-all opt-in", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    process.env.SLACK_APP_TOKEN = "xapp-x";
    process.env.SLACK_ALLOWED_USERS = " * ";
    expect(loadSlackConfig().allowedUsers).toEqual(["*"]);
  });

  it("parses allowed users CSV, trimming whitespace and blanks", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    process.env.SLACK_APP_TOKEN = "xapp-x";
    process.env.SLACK_ALLOWED_USERS = " U1 , ,U2,  ";
    expect(loadSlackConfig().allowedUsers).toEqual(["U1", "U2"]);
  });

  it("defaults requireMention to true and honors falsey values", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    process.env.SLACK_APP_TOKEN = "xapp-x";
    process.env.SLACK_ALLOWED_USERS = "U1";
    expect(loadSlackConfig().requireMention).toBe(true);
    process.env.SLACK_REQUIRE_MENTION = "0";
    expect(loadSlackConfig().requireMention).toBe(false);
    process.env.SLACK_REQUIRE_MENTION = "false";
    expect(loadSlackConfig().requireMention).toBe(false);
    process.env.SLACK_REQUIRE_MENTION = "yes";
    expect(loadSlackConfig().requireMention).toBe(true);
  });

  it("passes through COPILOT_TMUX_SESSION", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-x";
    process.env.SLACK_APP_TOKEN = "xapp-x";
    process.env.SLACK_ALLOWED_USERS = "U1";
    process.env.COPILOT_TMUX_SESSION = "omp-123";
    expect(loadSlackConfig().sessionEnv).toBe("omp-123");
  });
});
