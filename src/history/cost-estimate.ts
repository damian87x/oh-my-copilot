import type { PublicModelTokenRates, PublicPricingSnapshot } from "../skill-bench/telemetry.js";

/** 1 AI credit = 1e9 nano-AIU (same conversion as skill-bench). */
export const NANO_AIU_PER_CREDIT = 1_000_000_000;
/** 1 AI credit = $0.01 USD → $ = nano / 1e11. */
export const NANO_AIU_PER_USD = 100_000_000_000;

export const ESTIMATE_DISCLAIMER =
  "estimate only; not a provider invoice; session-level-only (not per-skill)";

export interface ModelUsageRow {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalNanoAiu?: number;
  aiCredits?: number;
  estimatedUsdFromCredits?: number;
  estimatedUsdFromPublicRates?: number;
}

export interface HistorySpendEstimates {
  source: "session-shutdown-nano-aiu" | "session-shutdown-nano-aiu+public-pricing";
  aiCredits?: number;
  estimatedUsdFromCredits?: number;
  byModel: ModelUsageRow[];
  pricing?: {
    attempted: boolean;
    matchedModels: string[];
    unresolvedModels: string[];
    sourceUrl?: string;
    retrievedAt?: string;
  };
  disclaimer: string;
}

export function nanoAiuToAiCredits(totalNanoAiu: number): number {
  return Number((totalNanoAiu / NANO_AIU_PER_CREDIT).toFixed(9));
}

export function nanoAiuToUsd(totalNanoAiu: number): number {
  return Number((totalNanoAiu / NANO_AIU_PER_USD).toFixed(12));
}

export function creditEstimatesFromNanoAiu(
  totalNanoAiu: number | undefined,
): Pick<HistorySpendEstimates, "aiCredits" | "estimatedUsdFromCredits"> {
  if (totalNanoAiu === undefined || !Number.isFinite(totalNanoAiu) || totalNanoAiu < 0) {
    return {};
  }
  return {
    aiCredits: nanoAiuToAiCredits(totalNanoAiu),
    estimatedUsdFromCredits: nanoAiuToUsd(totalNanoAiu),
  };
}

export function enrichModelRow(row: ModelUsageRow): ModelUsageRow {
  const credits = creditEstimatesFromNanoAiu(row.totalNanoAiu);
  return { ...row, ...credits };
}

function pricingRatesForModel(
  snapshot: PublicPricingSnapshot,
  modelId: string,
): PublicModelTokenRates | undefined {
  const normalized = modelId.toLowerCase();
  const candidates = [modelId, normalized, normalized.replace(/-picker$/, "")];
  for (const candidate of new Set(candidates)) {
    const rates = snapshot.models[candidate];
    if (rates) return rates;
  }
  return undefined;
}

function usdFromPublicRates(
  row: ModelUsageRow,
  rates: PublicModelTokenRates,
): number | undefined {
  const parts: number[] = [];
  const push = (tokens: number | undefined, rate: number | undefined): boolean => {
    if (tokens === undefined) return true;
    // Zero tokens need no rate (matches skill-bench optionalTokenCost).
    if (tokens === 0) {
      parts.push(0);
      return true;
    }
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) return false;
    parts.push((tokens * rate) / 1_000_000);
    return true;
  };
  if (!push(row.inputTokens, rates.inputUsdPerMillion)) return undefined;
  if (!push(row.outputTokens, rates.outputUsdPerMillion)) return undefined;
  if (!push(row.cacheReadTokens, rates.cacheReadUsdPerMillion)) return undefined;
  if (!push(row.cacheWriteTokens, rates.cacheWriteUsdPerMillion)) return undefined;
  if (parts.length === 0) return undefined;
  return Number(parts.reduce((sum, value) => sum + value, 0).toFixed(12));
}

export function buildSpendEstimates(options: {
  totalNanoAiu?: number;
  byModel: ModelUsageRow[];
  publicPricing?: PublicPricingSnapshot | null;
}): HistorySpendEstimates {
  const byModel = options.byModel.map(enrichModelRow).sort((left, right) => left.model.localeCompare(right.model));
  const base = creditEstimatesFromNanoAiu(options.totalNanoAiu);
  if (!options.publicPricing) {
    return {
      source: "session-shutdown-nano-aiu",
      ...base,
      byModel,
      disclaimer: ESTIMATE_DISCLAIMER,
    };
  }

  const matchedModels: string[] = [];
  const unresolvedModels: string[] = [];
  const priced = byModel.map((row) => {
    const rates = pricingRatesForModel(options.publicPricing!, row.model);
    if (!rates) {
      unresolvedModels.push(row.model);
      return row;
    }
    const estimatedUsdFromPublicRates = usdFromPublicRates(row, rates);
    if (estimatedUsdFromPublicRates === undefined) {
      unresolvedModels.push(row.model);
      return row;
    }
    matchedModels.push(row.model);
    return { ...row, estimatedUsdFromPublicRates };
  });

  return {
    source: "session-shutdown-nano-aiu+public-pricing",
    ...base,
    byModel: priced,
    pricing: {
      attempted: true,
      matchedModels,
      unresolvedModels,
      sourceUrl: options.publicPricing.url,
      retrievedAt: options.publicPricing.retrievedAt,
    },
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}
