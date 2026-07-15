export type TelemetrySource = "direct-session" | "live-model-metadata" | "public-price" | "unknown";

export interface RawTelemetryInput {
  direct?: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>;
  modelMetadata?: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  publicPricing?: { url: string; fetchedAt: string; estimatedCostUsd: number };
}

export interface KnownValue {
  value: number | null;
  known: boolean;
}

export interface PublicModelTokenRates {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  reasoningUsdPerMillion?: number;
}

export interface PublicPricingSnapshot {
  source?: string;
  apiUrl?: string;
  url: string;
  retrievedAt: string;
  currency: "USD";
  completeness?: string;
  models: Record<string, PublicModelTokenRates>;
  unresolvedTieredModels?: string[];
}

export function normalizeTelemetry(input: RawTelemetryInput): {
  provenance: { source: TelemetrySource; url?: string; fetchedAt?: string };
  tokens: { input: KnownValue; output: KnownValue; cacheRead: KnownValue; cacheWrite: KnownValue };
  costUsd: KnownValue;
} {
  if (input.direct) {
    return {
      provenance: { source: "direct-session" },
      tokens: tokenValues(input.direct),
      costUsd: knownNumber(input.direct.costUsd),
    };
  }
  if (input.modelMetadata) {
    return {
      provenance: { source: "live-model-metadata" },
      tokens: tokenValues(input.modelMetadata),
      costUsd: unknown(),
    };
  }
  if (input.publicPricing) {
    return {
      provenance: { source: "public-price", url: input.publicPricing.url, fetchedAt: input.publicPricing.fetchedAt },
      tokens: tokenValues({}),
      costUsd: knownNumber(input.publicPricing.estimatedCostUsd),
    };
  }
  return { provenance: { source: "unknown" }, tokens: tokenValues({}), costUsd: unknown() };
}

export function estimatePublicTokenCost(input: {
  modelId: string;
  usage: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  }>;
  snapshot: PublicPricingSnapshot;
}): KnownValue {
  if (
    input.snapshot.currency !== "USD" ||
    !input.snapshot.url ||
    !input.snapshot.retrievedAt
  ) {
    return unknown();
  }
  const rates = pricingRatesForModel(input.snapshot, input.modelId);
  if (!rates) return unknown();
  const inputTokens = input.usage.inputTokens;
  const outputTokens = input.usage.outputTokens;
  if (
    !nonNegative(inputTokens) ||
    !nonNegative(outputTokens) ||
    !nonNegative(rates.inputUsdPerMillion) ||
    !nonNegative(rates.outputUsdPerMillion)
  ) {
    return unknown();
  }
  const cacheReadTokens = input.usage.cacheReadTokens;
  let uncachedInputTokens = inputTokens;
  let cacheReadCost = 0;
  if (cacheReadTokens !== undefined) {
    if (
      !nonNegative(cacheReadTokens) ||
      cacheReadTokens > inputTokens ||
      (cacheReadTokens > 0 && !nonNegative(rates.cacheReadUsdPerMillion))
    ) {
      return unknown();
    }
    uncachedInputTokens -= cacheReadTokens;
    cacheReadCost =
      (cacheReadTokens * (rates.cacheReadUsdPerMillion ?? 0)) / 1_000_000;
  } else if (rates.cacheReadUsdPerMillion !== undefined) {
    return unknown();
  }
  const cacheWriteCost = optionalTokenCost(
    input.usage.cacheWriteTokens,
    rates.cacheWriteUsdPerMillion,
  );
  if (!cacheWriteCost.known) return unknown();
  const reasoningCost =
    rates.reasoningUsdPerMillion === undefined
      ? { value: 0, known: true }
      : optionalTokenCost(
          input.usage.reasoningTokens,
          rates.reasoningUsdPerMillion,
        );
  if (!reasoningCost.known) return unknown();
  const cost =
    (uncachedInputTokens * rates.inputUsdPerMillion) / 1_000_000 +
    cacheReadCost +
    (outputTokens * rates.outputUsdPerMillion) / 1_000_000 +
    (cacheWriteCost.value ?? 0) +
    (reasoningCost.value ?? 0);
  return { value: Number(cost.toFixed(12)), known: true };
}

function pricingRatesForModel(
  snapshot: PublicPricingSnapshot,
  modelId: string,
): PublicModelTokenRates | undefined {
  const normalized = modelId.toLowerCase();
  const candidates = [
    modelId,
    normalized,
    normalized.replace(/-picker$/, ""),
  ];
  for (const candidate of new Set(candidates)) {
    const rates = snapshot.models[candidate];
    if (rates) return rates;
  }
  return undefined;
}

function optionalTokenCost(
  tokens: number | undefined,
  rate: number | undefined,
): KnownValue {
  if (tokens === undefined && rate === undefined)
    return { value: 0, known: true };
  if (tokens === 0 && rate === undefined)
    return { value: 0, known: true };
  if (!nonNegative(tokens) || !nonNegative(rate)) return unknown();
  return { value: (tokens * rate) / 1_000_000, known: true };
}

function tokenValues(input: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) {
  return {
    input: knownNumber(input.inputTokens),
    output: knownNumber(input.outputTokens),
    cacheRead: knownNumber(input.cacheReadTokens),
    cacheWrite: knownNumber(input.cacheWriteTokens),
  };
}

function knownNumber(value: unknown): KnownValue {
  return nonNegative(value) ? { value, known: true } : unknown();
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function unknown(): KnownValue {
  return { value: null, known: false };
}
