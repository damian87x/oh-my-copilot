import { describe, it, expect } from "vitest";
import {
  handleSlackMessage,
  isUserAllowed,
  stripMention,
  type SlackHandlerDeps,
  type SlackMessageInput,
} from "../../src/slack/handler.js";
import type { ResolveSessionResult } from "../../src/comms/resolve-session.js";
import type { AskResult } from "../../src/comms/index.js";

const okResolve = (session = "omp-123"): ResolveSessionResult => ({
  ok: true,
  session,
  source: "discovery",
});
const failResolve = (error = "no running copilot session found"): ResolveSessionResult => ({
  ok: false,
  error,
});
const okAsk = (text: string): AskResult => ({ ok: true, session: "omp-123", text, sent: true });

function deps(over: Partial<SlackHandlerDeps> = {}): SlackHandlerDeps {
  return {
    resolve: () => okResolve(),
    ask: async () => okAsk("4"),
    allowedUsers: ["U1"],
    ...over,
  };
}

const dm = (over: Partial<SlackMessageInput> = {}): SlackMessageInput => ({
  text: "what is 2+2?",
  userId: "U1",
  channelType: "im",
  isMention: false,
  threadTs: "1700000000.0001",
  ...over,
});

describe("isUserAllowed", () => {
  it("denies everyone when list is empty/unset", () => {
    expect(isUserAllowed("U1", [])).toBe(false);
    expect(isUserAllowed("U1", undefined)).toBe(false);
    expect(isUserAllowed(undefined, null)).toBe(false);
  });
  it("allows everyone with wildcard", () => {
    expect(isUserAllowed("U9", ["*"])).toBe(true);
  });
  it("enforces the allowlist", () => {
    expect(isUserAllowed("U1", ["U1", "U2"])).toBe(true);
    expect(isUserAllowed("U9", ["U1", "U2"])).toBe(false);
    expect(isUserAllowed(undefined, ["U1"])).toBe(false);
  });
});

describe("stripMention", () => {
  it("removes the bot mention token and tidies whitespace", () => {
    expect(stripMention("<@B1> hello there", "B1")).toBe("hello there");
    expect(stripMention("hey <@B1>   build it", "B1")).toBe("hey build it");
  });
  it("leaves text alone when no botUserId", () => {
    expect(stripMention("plain text")).toBe("plain text");
  });
  it("handles a botUserId containing regex metacharacters (literal replace)", () => {
    expect(stripMention("hi <@U1)(> there", "U1)(")).toBe("hi there");
  });
});

describe("handleSlackMessage", () => {
  it("DM: forwards to Copilot and returns the reply in-thread", async () => {
    const r = await handleSlackMessage(dm(), deps({ ask: async () => okAsk("the answer is 4") }));
    expect(r.reply).toBe("the answer is 4");
    expect(r.threadTs).toBe("1700000000.0001");
  });

  it("channel without mention is ignored by default", async () => {
    const r = await handleSlackMessage(dm({ channelType: "channel", isMention: false }), deps());
    expect(r.reply).toBeNull();
  });

  it("channel with mention responds and strips the mention", async () => {
    let asked = "";
    const r = await handleSlackMessage(
      dm({ channelType: "channel", isMention: true, text: "<@B1> what is 2+2?", botUserId: "B1" }),
      deps({
        ask: async (_s, text) => {
          asked = text;
          return okAsk("4");
        },
      }),
    );
    expect(r.reply).toBe("4");
    expect(asked).toBe("what is 2+2?");
  });

  it("channel responds without mention when requireMention=false", async () => {
    const r = await handleSlackMessage(
      dm({ channelType: "channel", isMention: false }),
      deps({ requireMention: false }),
    );
    expect(r.reply).toBe("4");
  });

  it("ignores non-allowlisted users", async () => {
    const r = await handleSlackMessage(dm({ userId: "U9" }), deps({ allowedUsers: ["U1"] }));
    expect(r.reply).toBeNull();
  });

  it("allows allowlisted users", async () => {
    const r = await handleSlackMessage(dm({ userId: "U1" }), deps({ allowedUsers: ["U1"] }));
    expect(r.reply).toBe("4");
  });

  it("allows any user only when the wildcard opt-in is explicit", async () => {
    const r = await handleSlackMessage(dm({ userId: "U9" }), deps({ allowedUsers: ["*"] }));
    expect(r.reply).toBe("4");
  });

  it("surfaces a resolution failure as a friendly reply", async () => {
    const r = await handleSlackMessage(dm(), deps({ resolve: () => failResolve("no running copilot session") }));
    expect(r.reply).toMatch(/no running copilot session/);
  });

  it("surfaces an ask error (offline/busy/no-session) as a friendly reply", async () => {
    const r = await handleSlackMessage(
      dm(),
      deps({ ask: async () => ({ ok: false, error: "offline: no internet connectivity", sent: false }) }),
    );
    expect(r.reply).toMatch(/offline/);
  });

  it("handles a timeout with a still-working note", async () => {
    const r = await handleSlackMessage(
      dm(),
      deps({ ask: async () => ({ ok: true, session: "omp-123", text: "partial", timedOut: true, sent: true }) }),
    );
    expect(r.reply).toMatch(/still working/);
    expect(r.reply).toMatch(/partial/);
  });

  it("turns a thrown resolve() into a friendly reply (no rejection)", async () => {
    const r = await handleSlackMessage(
      dm(),
      deps({
        resolve: () => {
          throw new Error("tmux exploded");
        },
      }),
    );
    expect(r.reply).toMatch(/could not resolve copilot session/);
    expect(r.reply).toMatch(/tmux exploded/);
  });

  it("turns a rejected ask() into a friendly reply (no rejection)", async () => {
    const r = await handleSlackMessage(
      dm(),
      deps({
        ask: async () => {
          throw new Error("bridge died");
        },
      }),
    );
    expect(r.reply).toMatch(/copilot request failed/);
    expect(r.reply).toMatch(/bridge died/);
  });

  it("empty text after stripping the mention stays silent", async () => {
    const r = await handleSlackMessage(
      dm({ channelType: "channel", isMention: true, text: "<@B1>", botUserId: "B1" }),
      deps(),
    );
    expect(r.reply).toBeNull();
  });
});
