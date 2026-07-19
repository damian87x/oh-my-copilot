import {
  estimatePublicTokenCost,
  type PublicPricingSnapshot,
} from "../skill-bench/telemetry.js";

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
    // Reuse skill-bench pricing so cache-read is not double-counted as input.
    const estimated = estimatePublicTokenCost({
      modelId: row.model,
      usage: {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      },
      snapshot: options.publicPricing!,
    });
    if (!estimated.known || typeof estimated.value !== "number") {
      unresolvedModels.push(row.model);
      return row;
    }
    matchedModels.push(row.model);
    return { ...row, estimatedUsdFromPublicRates: estimated.value };
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
