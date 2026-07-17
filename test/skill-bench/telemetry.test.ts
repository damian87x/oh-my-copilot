import { describe, expect, it } from "vitest";
import {
  estimatePublicTokenCost,
  normalizeTelemetry,
} from "../../src/skill-bench/telemetry.js";

describe("skill-bench telemetry provenance", () => {
  it("uses direct session telemetry before model metadata before public pricing before unknown", () => {
    expect(normalizeTelemetry({ direct: { inputTokens: 10, outputTokens: 5, costUsd: 0.03 } }).provenance.source).toBe("direct-session");
    expect(normalizeTelemetry({ modelMetadata: { inputTokens: 10, outputTokens: 5 } }).provenance.source).toBe("live-model-metadata");
    expect(normalizeTelemetry({ publicPricing: { url: "https://example.invalid/prices", fetchedAt: "2026-07-14", estimatedCostUsd: 0.04 } }).provenance.source).toBe("public-price");
    expect(normalizeTelemetry({}).provenance.source).toBe("unknown");
  });

  it("keeps unknown token categories unknown rather than zero-filled", () => {
    const telemetry = normalizeTelemetry({ direct: { inputTokens: 10 } });

    expect(telemetry.tokens.input).toEqual({ value: 10, known: true });
    expect(telemetry.tokens.output).toEqual({ value: null, known: false });
    expect(telemetry.tokens.cacheRead).toEqual({ value: null, known: false });
    expect(telemetry.costUsd).toEqual({ value: null, known: false });
    expect(JSON.stringify(telemetry)).not.toContain('"value":0');
  });

  it("derives a public USD estimate only from a complete reviewed model-rate snapshot", () => {
    const snapshot = {
      url: "https://prices.example/models",
      retrievedAt: "2026-07-14T00:00:00Z",
      currency: "USD",
      models: {
        "model-a": {
          inputUsdPerMillion: 1,
          cacheReadUsdPerMillion: 0.1,
          outputUsdPerMillion: 2,
        },
      },
    };

    expect(
      estimatePublicTokenCost({
        modelId: "model-a",
        usage: { inputTokens: 3_000, cacheReadTokens: 2_000, outputTokens: 500 },
        snapshot,
      }),
    ).toEqual({ value: 0.0022, known: true });
    expect(
      estimatePublicTokenCost({
        modelId: "model-a",
        usage: { inputTokens: 1_000, cacheReadTokens: 2_000, outputTokens: 500 },
        snapshot,
      }),
    ).toEqual({ value: null, known: false });
    expect(
      estimatePublicTokenCost({
        modelId: "model-a",
        usage: { inputTokens: 1_000 },
        snapshot,
      }),
    ).toEqual({ value: null, known: false });
    expect(
      estimatePublicTokenCost({
        modelId: "model-a",
        usage: { inputTokens: 1_000, cacheWriteTokens: 1, outputTokens: 500 },
        snapshot,
      }),
    ).toEqual({ value: null, known: false });
    expect(
      estimatePublicTokenCost({
        modelId: "model-a",
        usage: { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 100 },
        snapshot,
      }),
    ).toEqual({ value: 0.002, known: true });
  });

  it("maps Copilot picker model ids to the official pricing model id", () => {
    const snapshot = {
      url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
      retrievedAt: "2026-07-15T12:00:00Z",
      currency: "USD" as const,
      models: {
        "mai-code-1-flash": {
          inputUsdPerMillion: 0.75,
          cacheReadUsdPerMillion: 0.075,
          outputUsdPerMillion: 4.5,
        },
      },
    };

    expect(
      estimatePublicTokenCost({
        modelId: "mai-code-1-flash-picker",
        usage: {
          inputTokens: 122_630,
          cacheReadTokens: 87_168,
          cacheWriteTokens: 0,
          outputTokens: 1_384,
        },
        snapshot,
      }),
    ).toEqual({ value: 0.0393621, known: true });
  });
});
