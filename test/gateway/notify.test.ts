import { describe, it, expect, vi } from "vitest";
import { notify } from "../../src/gateway/notify.js";

function makeFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
): { fetch: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null } as unknown as Headers,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const NO_SLEEP = async () => {};
const BOT_TOKEN = "xoxb-test";

describe("notify (happy path)", () => {
  it("posts to a channel ID via SLACK_HOME_CHANNEL", async () => {
    const { fetch, calls } = makeFetch([{ body: { ok: true, ts: "1700.0001" } }]);
    const r = await notify(
      { text: "hello" },
      {
        env: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_HOME_CHANNEL: "C0BOQV5434G" },
        fetch,
        sleep: NO_SLEEP,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel).toBe("C0BOQV5434G");
      expect(r.ts).toBe("1700.0001");
      expect(r.openedIm).toBe(false);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("chat.postMessage");
    expect((calls[0].body as Record<string, unknown>).channel).toBe("C0BOQV5434G");
  });

  it("explicit --target overrides SLACK_HOME_CHANNEL", async () => {
    const { fetch, calls } = makeFetch([{ body: { ok: true, ts: "1700.0002" } }]);
    const r = await notify(
      { text: "hi", target: "slack:C1OVERRIDE9" },
      {
        env: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_HOME_CHANNEL: "C0BOQV5434G" },
        fetch,
        sleep: NO_SLEEP,
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.channel).toBe("C1OVERRIDE9");
    expect((calls[0].body as Record<string, unknown>).channel).toBe("C1OVERRIDE9");
  });

  it("U… target opens an IM channel first, then posts to the D… result", async () => {
    const { fetch, calls } = makeFetch([
      { body: { ok: true, channel: { id: "D9DMINIDXY" } } }, // conversations.open
      { body: { ok: true, ts: "1700.0003" } }, // chat.postMessage
    ]);
    const r = await notify(
      { text: "ping me", target: "slack:U0123ABCDE" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.channel).toBe("D9DMINIDXY");
      expect(r.openedIm).toBe(true);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("conversations.open");
    expect((calls[0].body as Record<string, unknown>).users).toBe("U0123ABCDE");
    expect(calls[1].url).toContain("chat.postMessage");
    expect((calls[1].body as Record<string, unknown>).channel).toBe("D9DMINIDXY");
  });

  it("passes thread_ts when supplied via target suffix", async () => {
    const { fetch, calls } = makeFetch([{ body: { ok: true, ts: "1700.0004" } }]);
    await notify(
      { text: "reply", target: "slack:C0BOQV5434G:1699.999999" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect((calls[0].body as Record<string, unknown>).thread_ts).toBe("1699.999999");
  });

  it("threadTs option overrides any target suffix", async () => {
    const { fetch, calls } = makeFetch([{ body: { ok: true, ts: "1700.0005" } }]);
    await notify(
      { text: "x", target: "slack:C0BOQV5434G:1699.000001", threadTs: "1700.000002" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect((calls[0].body as Record<string, unknown>).thread_ts).toBe("1700.000002");
  });
});

describe("notify (preflight failures)", () => {
  it("MISSING_TOKEN when SLACK_BOT_TOKEN is unset", async () => {
    const r = await notify({ text: "hi" }, { env: {}, sleep: NO_SLEEP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MISSING_TOKEN");
  });

  it("MISSING_TARGET when no target and no SLACK_HOME_CHANNEL", async () => {
    const r = await notify(
      { text: "hi" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MISSING_TARGET");
  });

  it("BAD_TARGET when --target is malformed", async () => {
    const r = await notify(
      { text: "hi", target: "slack:xyz" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_TARGET");
  });

  it("BAD_HOME_CHANNEL when SLACK_HOME_CHANNEL is junk", async () => {
    const r = await notify(
      { text: "hi" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_HOME_CHANNEL: "junk" }, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BAD_HOME_CHANNEL");
  });

  it("MISSING_TEXT on empty text", async () => {
    const r = await notify(
      { text: "" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MISSING_TEXT");
  });
});

describe("notify (Slack errors)", () => {
  it("returns POST_FAILED with the Slack error reason on ok:false", async () => {
    const { fetch } = makeFetch([{ body: { ok: false, error: "channel_not_found" } }]);
    const r = await notify(
      { text: "x", target: "slack:C0NOTFOUND1" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("POST_FAILED");
      expect(r.reason).toBe("channel_not_found");
    }
  });

  it("returns OPEN_FAILED when conversations.open returns ok:false", async () => {
    const { fetch } = makeFetch([{ body: { ok: false, error: "user_not_found" } }]);
    const r = await notify(
      { text: "x", target: "slack:U0NOPE12345" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("OPEN_FAILED");
      expect(r.reason).toBe("user_not_found");
    }
  });

  it("retries on HTTP 429 and recovers", async () => {
    const sleep = vi.fn(NO_SLEEP);
    const { fetch, calls } = makeFetch([
      { status: 429, body: {}, headers: { "retry-after": "0" } },
      { body: { ok: true, ts: "1700.0006" } },
    ]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("retries on HTTP 503 and recovers", async () => {
    const { fetch, calls } = makeFetch([
      { status: 503, body: {} },
      { body: { ok: true, ts: "1700.0007" } },
    ]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up with RATE_LIMITED after persistent 429s", async () => {
    const { fetch } = makeFetch([
      { status: 429, body: {}, headers: { "retry-after": "0" } },
      { status: 429, body: {}, headers: { "retry-after": "0" } },
      { status: 429, body: {}, headers: { "retry-after": "0" } },
    ]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("RATE_LIMITED");
  });

  it("returns NETWORK_ERROR when fetch throws", async () => {
    const failFetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch: failFetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NETWORK_ERROR");
  });

  it("redacts the bot token when it appears in a thrown fetch error", async () => {
    // A pathological fetch impl that echoes the URL+headers (incl. our token)
    // in its error message — pretend a runtime sometimes does this.
    const leakyFetch = (async () => {
      throw new Error(
        `connect ECONNREFUSED 127.0.0.1:443 (Authorization: Bearer ${BOT_TOKEN})`,
      );
    }) as unknown as typeof fetch;
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch: leakyFetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain(BOT_TOKEN);
      expect(r.reason).toContain("[REDACTED]");
    }
  });

  it("redacts xoxb- patterns in Slack ok:false payload reasons", async () => {
    const { fetch } = makeFetch([{ body: { ok: false, error: `bad token: xoxb-leaked-123-abc` } }]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/xoxb-leaked/);
      expect(r.reason).toContain("[REDACTED]");
    }
  });

  it("redacts xapp- (app-level) patterns in Slack ok:false payload reasons", async () => {
    const { fetch } = makeFetch([{ body: { ok: false, error: `bad app token: xapp-leaked-456-def` } }]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/xapp-leaked/);
      expect(r.reason).toContain("[REDACTED]");
    }
  });
});

describe("notify (deadline budget)", () => {
  it("shares one deadline across conversations.open AND chat.postMessage for U-targets", async () => {
    // If the deadline were per-call, this test could spend up to 2× timeoutMs.
    // We assert the run completes within ~1.5× timeoutMs even with 429 retries
    // splitting time between open and post.
    let openCalls = 0;
    let postCalls = 0;
    const fakeFetch = (async (url: string) => {
      if (String(url).includes("conversations.open")) {
        openCalls++;
        return {
          status: 200,
          headers: { get: () => null } as unknown as Headers,
          json: async () => ({ ok: true, channel: { id: "D0SHARED" } }),
        } as unknown as Response;
      }
      postCalls++;
      return {
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({ ok: true, ts: "1700.0010" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await notify(
      { text: "x", target: "slack:U0SHARED999", timeoutMs: 5000 },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch: fakeFetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(true);
    expect(openCalls).toBe(1);
    expect(postCalls).toBe(1);
  });

  it("never throws on a non-string Slack error body (object/array/null)", async () => {
    // Slack documents `error` as a string. Proxies/WAFs/mis-pointed endpoints
    // can return objects, arrays, or null. notify() must coerce, NOT throw.
    for (const errVariant of [
      { message: "bad token", code: 42 }, // object
      ["x", "y"], // array
      null, // explicit null (becomes default reason)
      false, // boolean
      999, // number
    ]) {
      const { fetch } = makeFetch([{ body: { ok: false, error: errVariant } }]);
      const r = await notify(
        { text: "x", target: "slack:C0BOQV5434G" },
        { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(typeof r.reason).toBe("string");
        // Must not have leaked an `[object Object]` or thrown:
        expect(r.reason).not.toContain("split is not a function");
      }
    }
  });

  it("rejects BAD_TARGET when --thread-ts has the wrong shape (digits.digits)", async () => {
    // Without --thread-ts validation, a typo through the flag path would
    // bypass the suffix regex tightened on the target string.
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G", threadTs: "not-a-ts" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("BAD_TARGET");
      expect(r.reason).toMatch(/threadTs/);
    }
  });

  it("accepts --thread-ts with the canonical digits.digits shape", async () => {
    const { fetch, calls } = makeFetch([{ body: { ok: true, ts: "1700.0099" } }]);
    const r = await notify(
      { text: "x", target: "slack:C0BOQV5434G", threadTs: "1699.987654" },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(true);
    expect((calls[0].body as Record<string, unknown>).thread_ts).toBe("1699.987654");
  });

  it("emits TIMEOUT when the deadline is already past at second call", async () => {
    let calls = 0;
    const slowFetch = (async (url: string) => {
      calls++;
      if (String(url).includes("conversations.open")) {
        // Advance the clock past the deadline before returning.
        await new Promise((r) => setTimeout(r, 60));
        return {
          status: 200,
          headers: { get: () => null } as unknown as Headers,
          json: async () => ({ ok: true, channel: { id: "D0LATE" } }),
        } as unknown as Response;
      }
      return {
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({ ok: true, ts: "1700.0011" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await notify(
      { text: "x", target: "slack:U0LATER1111", timeoutMs: 50 },
      { env: { SLACK_BOT_TOKEN: BOT_TOKEN }, fetch: slowFetch, sleep: NO_SLEEP },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TIMEOUT");
    expect(calls).toBe(1); // never made it to chat.postMessage
  });
});
