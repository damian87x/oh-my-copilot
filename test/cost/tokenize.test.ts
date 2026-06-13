import { describe, expect, it } from "vitest";
import { countTokens } from "../../src/cost/tokenize.js";

describe("countTokens", () => {
  it("uses a deterministic lightweight estimate", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("1234")).toBe(1);
    expect(countTokens("12345")).toBe(2);
  });

  it("normalizes non-string inputs without throwing", () => {
    expect(countTokens(undefined)).toBe(0);
    expect(countTokens({ command: "printf hello" })).toBeGreaterThan(0);
  });
});
