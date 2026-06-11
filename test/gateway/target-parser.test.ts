import { describe, it, expect } from "vitest";
import {
  parseTarget,
  parseSlackRef,
  looksLikeSlackId,
} from "../../src/gateway/target-parser.js";

describe("parseTarget", () => {
  it("parses a public channel target", () => {
    const r = parseTarget("slack:C0BOQV5434G");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({
      platform: "slack",
      kind: "channel",
      id: "C0BOQV5434G",
      threadTs: undefined,
    });
  });

  it("parses a private (group) channel target", () => {
    const r = parseTarget("slack:G1ABCDEFGHI");
    if (r.ok) expect(r.target.kind).toBe("group");
  });

  it("parses a direct-message (D…) target", () => {
    const r = parseTarget("slack:D0123ABCDXY");
    if (r.ok) expect(r.target.kind).toBe("dm");
  });

  it("parses a user (U…) target — caller must conversations.open", () => {
    const r = parseTarget("slack:U0123ABCDE");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toEqual({
      platform: "slack",
      kind: "user",
      id: "U0123ABCDE",
      threadTs: undefined,
    });
  });

  it("parses channel + thread_ts suffix (digits.digits only)", () => {
    const r = parseTarget("slack:C0BOQV5434G:1700000000.000123");
    if (r.ok) {
      expect(r.target.id).toBe("C0BOQV5434G");
      expect(r.target.threadTs).toBe("1700000000.000123");
    }
  });

  it("rejects a thread suffix that isn't the digits.digits Slack shape", () => {
    expect(parseTarget("slack:C0BOQV5434G:hello").ok).toBe(false);
    expect(parseTarget("slack:C0BOQV5434G:not-a-ts").ok).toBe(false);
    expect(parseTarget("slack:C0BOQV5434G:1700000000").ok).toBe(false); // missing fractional part
  });

  it("rejects bare platform with no ref", () => {
    expect(parseTarget("slack").ok).toBe(false);
    expect(parseTarget("slack:").ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(parseTarget("").ok).toBe(false);
    expect(parseTarget("   ").ok).toBe(false);
  });

  it("rejects unsupported platforms in slice 1", () => {
    const r = parseTarget("telegram:-12345");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/telegram/);
  });

  it("rejects a malformed Slack ID (too short, wrong prefix)", () => {
    expect(parseTarget("slack:C1").ok).toBe(false); // too short
    expect(parseTarget("slack:X0123ABCDE").ok).toBe(false); // bad prefix
    expect(parseTarget("slack:c0123ABCDE").ok).toBe(false); // lowercase
  });

  it("normalises whitespace and lowercases the platform", () => {
    const r = parseTarget("  SLACK:C0BOQV5434G  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.id).toBe("C0BOQV5434G");
  });
});

describe("parseSlackRef", () => {
  it("accepts a bare Slack ID without platform prefix", () => {
    const r = parseSlackRef("U0123ABCDE");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.kind).toBe("user");
  });

  it("accepts channel + thread", () => {
    const r = parseSlackRef("C0BOQV5434G:1700.000123");
    if (r.ok) {
      expect(r.target.id).toBe("C0BOQV5434G");
      expect(r.target.threadTs).toBe("1700.000123");
    }
  });

  it("does NOT accept a thread suffix on a user-id target", () => {
    // Threading a U… makes no sense — needs D-conversion first.
    const r = parseSlackRef("U0123ABCDE:1700.000123");
    expect(r.ok).toBe(false);
  });
});

describe("looksLikeSlackId", () => {
  it("matches the four valid prefixes", () => {
    expect(looksLikeSlackId("C0BOQV5434G")).toBe(true);
    expect(looksLikeSlackId("G1ABCDEFGHI")).toBe(true);
    expect(looksLikeSlackId("D0123ABCDXY")).toBe(true);
    expect(looksLikeSlackId("U0123ABCDE")).toBe(true);
  });

  it("rejects junk", () => {
    expect(looksLikeSlackId("")).toBe(false);
    expect(looksLikeSlackId("hello")).toBe(false);
    expect(looksLikeSlackId("xoxb-123")).toBe(false);
    expect(looksLikeSlackId("u0123abcde")).toBe(false); // lowercase
  });

  it("ignores surrounding whitespace", () => {
    expect(looksLikeSlackId("  U0123ABCDE  ")).toBe(true);
  });
});
