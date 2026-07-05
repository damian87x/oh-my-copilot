import { describe, it, expect } from "vitest";
import { createSlackConnector, slackDoctor } from "../../src/gateway/connectors/slack.js";
import type { BoltLike, SaySig, SlackMessage } from "../../src/gateway/connectors/slack.js";
import type { AskResult } from "../../src/comms/index.js";
import type { SlackConfig } from "../../src/slack/config.js";

function makeConfig(over: Partial<SlackConfig> = {}): SlackConfig {
  return {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    allowedUsers: ["U1"],
    requireMention: true,
    sessionEnv: undefined,
    ...over,
  };
}

function makeBolt(
  opts: { authUserId?: string; failStart?: string } = {},
): {
  app: BoltLike;
  startCalls: number;
  stopCalls: number;
  messageHandler?: (args: { message: SlackMessage; say: SaySig }) => Promise<void>;
  mentionHandler?: (args: { event: SlackMessage; say: SaySig }) => Promise<void>;
} {
  const ref: ReturnType<typeof makeBolt> = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app: undefined as any,
    startCalls: 0,
    stopCalls: 0,
  };
  ref.app = {
    client: {
      auth: { test: async () => ({ user_id: opts.authUserId ?? "B1" }) },
    },
    message(handler) {
      ref.messageHandler = handler;
    },
    event(_name, handler) {
      ref.mentionHandler = handler;
    },
    async start() {
      ref.startCalls++;
      if (opts.failStart) throw new Error(opts.failStart);
    },
    async stop() {
      ref.stopCalls++;
    },
  };
  return ref;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function dm(text: string, ts: string): SlackMessage {
  return {
    text,
    user: "U1",
    channel_type: "im",
    ts,
  };
}

describe("createSlackConnector", () => {
  it("returns a Connector named 'slack' with status 'not started' before start()", () => {
    const c = createSlackConnector({ config: makeConfig(), appFactory: () => makeBolt().app, log: () => {} });
    expect(c.name).toBe("slack");
    expect(c.status()).toEqual({ ready: false, detail: "not started" });
  });

  it("refuses to start when the allowlist is empty", async () => {
    let appFactoryCalled = false;
    const c = createSlackConnector({
      config: makeConfig({ allowedUsers: [] }),
      appFactory: () => {
        appFactoryCalled = true;
        return makeBolt().app;
      },
      log: () => {},
    });
    await expect(c.start()).rejects.toThrow(/SLACK_ALLOWED_USERS=.*\*/);
    expect(appFactoryCalled).toBe(false);
    expect(c.status().detail).toMatch(/SLACK_ALLOWED_USERS=.*\*/);
  });

  it("starts with a warning when wildcard allow-all is explicit", async () => {
    const bolt = makeBolt();
    const logs: string[] = [];
    const c = createSlackConnector({
      config: makeConfig({ allowedUsers: ["*"] }),
      appFactory: () => bolt.app,
      log: (msg) => logs.push(msg),
    });
    await c.start();
    expect(c.status()).toEqual({ ready: true });
    expect(bolt.startCalls).toBe(1);
    expect(logs.some((msg) => msg.includes("SLACK_ALLOWED_USERS=*"))).toBe(true);
  });

  it("doctor reports an empty allowlist as not ready", () => {
    const doctor = slackDoctor(makeConfig({ allowedUsers: [] }));
    const status = doctor.doctor();
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/SLACK_ALLOWED_USERS=.*\*/);
  });

  it("status becomes ready after a successful start()", async () => {
    const bolt = makeBolt();
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
    });
    await c.start();
    expect(c.status()).toEqual({ ready: true });
    expect(bolt.startCalls).toBe(1);
    await c.stop();
    expect(bolt.stopCalls).toBe(1);
    expect(c.status().ready).toBe(false);
  });

  it("records error and rethrows when start() fails; status reports the error", async () => {
    const bolt = makeBolt({ failStart: "auth blew up" });
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
    });
    await expect(c.start()).rejects.toThrow(/auth blew up/);
    expect(c.status()).toEqual({ ready: false, detail: "auth blew up" });
  });

  it("stop() is idempotent — safe to call twice and safe to call before start()", async () => {
    const bolt = makeBolt();
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
    });
    await c.stop(); // never started → no-op, no throw
    await c.start();
    await c.stop();
    await c.stop(); // already stopped
    expect(bolt.stopCalls).toBe(1);
  });

  it("DM handler: top-level DM gets an INLINE reply (no thread_ts) so Slack shows it in the conversation", async () => {
    // Slack DMs hide thread replies under a 'View thread' link, which looks
    // like the bot never responded. Top-level DMs must post inline.
    const bolt = makeBolt({ authUserId: "B1" });
    const seen: { session?: string; text?: string } = {};
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (session, text) => {
          seen.session = session;
          seen.text = text;
          return { ok: true, session, text: "pong", sent: true };
        },
      },
    });
    await c.start();
    let said: { text: string; thread_ts?: string } | undefined;
    const say: SaySig = async (m) => {
      said = m;
      return undefined;
    };
    await bolt.messageHandler!({
      message: {
        text: "ping",
        user: "U1",
        channel_type: "im",
        ts: "1.0",
      },
      say,
    });
    expect(seen.text).toBe("ping");
    expect(said?.text).toBe("pong");
    expect(said?.thread_ts).toBeUndefined();
  });

  it("DM handler: when the user wrote IN a thread, the bot replies IN that thread", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (s, t) => ({ ok: true, session: s, text: t, sent: true }),
      },
    });
    await c.start();
    let said: { text: string; thread_ts?: string } | undefined;
    const say: SaySig = async (m) => {
      said = m;
      return undefined;
    };
    await bolt.messageHandler!({
      message: {
        text: "ping",
        user: "U1",
        channel_type: "im",
        ts: "2.0",
        thread_ts: "1.5", // user replied inside an existing thread
      },
      say,
    });
    expect(said?.thread_ts).toBe("1.5");
  });

  it("DM handler ignores messages from the bot itself", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    let asked = false;
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async () => {
          asked = true;
          return { ok: true, session: "omp-1", text: "x", sent: true };
        },
      },
    });
    await c.start();
    const say: SaySig = async () => undefined;
    await bolt.messageHandler!({
      message: { user: "B1", channel_type: "im", text: "self", ts: "1.0" },
      say,
    });
    expect(asked).toBe(false);
  });

  it("app_mention handler responds in-thread with the bot mention stripped", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    let asked = "";
    const c = createSlackConnector({
      config: makeConfig({ allowedUsers: ["U2"] }),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (_s, text) => {
          asked = text;
          return { ok: true, session: "omp-1", text: "ok", sent: true };
        },
      },
    });
    await c.start();
    let said: { text: string; thread_ts?: string } | undefined;
    const say: SaySig = async (m) => {
      said = m;
      return undefined;
    };
    await bolt.mentionHandler!({
      event: { user: "U2", text: "<@B1> hello", ts: "2.0" },
      say,
    });
    expect(asked).toBe("hello");
    expect(said?.thread_ts).toBe("2.0");
  });

  it("serializes overlapping DMs per resolved session and attributes replies correctly", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    const first = deferred<AskResult>();
    const second = deferred<AskResult>();
    const starts: string[] = [];
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (_session, text) => {
          starts.push(text);
          if (text === "first") return first.promise;
          if (text === "second") return second.promise;
          throw new Error(`unexpected ask: ${text}`);
        },
      },
    });
    await c.start();

    let firstReply: { text: string; thread_ts?: string } | undefined;
    let secondReply: { text: string; thread_ts?: string } | undefined;
    const p1 = bolt.messageHandler!({
      message: dm("first", "1.0"),
      say: async (m) => {
        firstReply = m;
        return undefined;
      },
    });
    const p2 = bolt.messageHandler!({
      message: dm("second", "2.0"),
      say: async (m) => {
        secondReply = m;
        return undefined;
      },
    });

    await flushPromises();
    expect(starts).toEqual(["first"]);

    first.resolve({ ok: true, session: "omp-1", text: "reply one", sent: true });
    await p1;
    await flushPromises();
    expect(starts).toEqual(["first", "second"]);

    second.resolve({ ok: true, session: "omp-1", text: "reply two", sent: true });
    await p2;
    expect(firstReply?.text).toBe("reply one");
    expect(secondReply?.text).toBe("reply two");
  });

  it("rejects a fourth pending DM to one session with a busy reply without enqueueing it", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    const asks = new Map<string, Deferred<AskResult>>();
    const starts: string[] = [];
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (_session, text) => {
          starts.push(text);
          const d = asks.get(text);
          if (!d) throw new Error(`unexpected ask: ${text}`);
          return d.promise;
        },
      },
    });
    await c.start();

    const replies = new Map<string, string>();
    const promises: Promise<void>[] = [];
    for (let i = 1; i <= 5; i++) {
      const text = `msg-${i}`;
      if (i <= 4) asks.set(text, deferred<AskResult>());
      promises.push(
        bolt.messageHandler!({
          message: dm(text, `${i}.0`),
          say: async (m) => {
            replies.set(text, m.text);
            return undefined;
          },
        }),
      );
    }

    await flushPromises();
    await promises[4];
    expect(replies.get("msg-5")).toMatch(/worker busy, try again shortly/i);
    expect(starts).toEqual(["msg-1"]);

    for (let i = 1; i <= 4; i++) {
      asks.get(`msg-${i}`)!.resolve({ ok: true, session: "omp-1", text: `reply ${i}`, sent: true });
      await flushPromises();
    }

    await Promise.all(promises.slice(0, 4));
    expect(starts).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(starts).not.toContain("msg-5");
  });

  it("advances the session queue after a timed-out comms result", async () => {
    const bolt = makeBolt({ authUserId: "B1" });
    const slow = deferred<AskResult>();
    const starts: string[] = [];
    const c = createSlackConnector({
      config: makeConfig(),
      appFactory: () => bolt.app,
      log: () => {},
      handlerDeps: {
        resolve: () => ({ ok: true, session: "omp-1", source: "discovery" }),
        ask: async (session, text) => {
          starts.push(text);
          if (text === "slow") return slow.promise;
          if (text === "after") return { ok: true, session, text: "done", sent: true };
          throw new Error(`unexpected ask: ${text}`);
        },
      },
    });
    await c.start();

    let slowReply: string | undefined;
    let afterReply: string | undefined;
    const p1 = bolt.messageHandler!({
      message: dm("slow", "1.0"),
      say: async (m) => {
        slowReply = m.text;
        return undefined;
      },
    });
    const p2 = bolt.messageHandler!({
      message: dm("after", "2.0"),
      say: async (m) => {
        afterReply = m.text;
        return undefined;
      },
    });

    await flushPromises();
    expect(starts).toEqual(["slow"]);

    slow.resolve({ ok: true, session: "omp-1", text: "partial output", timedOut: true, sent: true });
    await p1;
    await p2;
    expect(starts).toEqual(["slow", "after"]);
    expect(slowReply).toContain("Copilot is still working");
    expect(slowReply).toContain("partial output");
    expect(afterReply).toBe("done");
  });
});
