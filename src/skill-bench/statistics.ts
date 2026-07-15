import { stableHash } from "./types.js";

export interface ComparisonFamilyV1 {
  comparisonFamilyId: string;
  frozenPairIds: string[];
  comparisonCount: number;
}

export interface ConsensusRevision2Metadata {
  familywiseAlpha: 0.05;
  maxLooks: number;
  currentLook: number;
  comparisonFamilyId: string;
  comparisonCount: number;
  alpha: number;
  lowerQuantile: number;
  upperQuantile: number;
  frozenPairIds: string[];
  resamples: number;
  seed: string;
  sampleCount: number;
  coverage: number;
}

export type ComparisonVerdict = "winner" | "tie" | "inconclusive";

export interface ComparisonResult {
  comparisonId: string;
  mean: number;
  lower: number;
  upper: number;
  verdict: ComparisonVerdict;
  metadata: ConsensusRevision2Metadata;
}

export type ConsensusRevision2Validation = { ok: true } | { ok: false; reason: string };

export const PROTOCOL_MINIMUM_MATCHED_UNITS = 6;
export const PROTOCOL_BOOTSTRAP_RESAMPLES = 10_000;
export type ValidatedStopReasonFamily = "confidence" | "budget" | "exhaustion" | "cancellation" | "failure";
export type ValidatedRunStatus = "refuse" | "continue" | "winner" | "tie" | "inconclusive";

export interface ValidatedSamplingDecision {
  status: ValidatedRunStatus;
  stopReason: ValidatedStopReasonFamily | null;
  stopDetail?: string;
  matchedUnits: number;
  requiredMatchedUnits: number;
  evidenceGate: "passed" | "min-matched-units" | "scenario-coverage" | "statistics-metadata" | "approved-budget-too-small";
  result?: ComparisonResult;
}

export interface ValidatedSamplingInput {
  matchedUnits: number;
  minimumMatchedUnits?: number;
  approvedMaximumMatchedUnits?: number;
  scenarioFamilyCounts?: Record<string, number>;
  requiredScenarioFamilies?: string[];
  comparisonResults?: ComparisonResult[];
  budgetReached?: boolean;
  budgetDetail?: string;
  exhausted?: boolean;
  cancelled?: boolean;
  failure?: boolean;
}

export function freezeComparisonFamily(input: { comparisonFamilyId: string; armIds: string[] }): ComparisonFamilyV1 {
  const unique = [...new Set(input.armIds)].sort();
  const frozenPairIds: string[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) frozenPairIds.push(`${unique[i]}__${unique[j]}`);
  }
  return {
    comparisonFamilyId: input.comparisonFamilyId,
    frozenPairIds,
    comparisonCount: Math.max(1, frozenPairIds.length),
  };
}

export function protocolFingerprint(input: { family: ComparisonFamilyV1; maxLooks: number; resamples: number; seed: string }): string {
  return stableHash({ protocol: "consensus-revision-2", ...input });
}

export function comparePairedDifferences(input: {
  comparisonId: string;
  comparisonFamily: ComparisonFamilyV1;
  differences: number[];
  maxLooks: number;
  currentLook: number;
  resamples?: number;
  seed: string;
  practicalDifference?: number;
}): ComparisonResult {
  const resamples = input.resamples ?? PROTOCOL_BOOTSTRAP_RESAMPLES;
  if (!input.comparisonFamily.frozenPairIds.includes(input.comparisonId)) throw new Error("comparison id was not frozen before execution");
  if (!Number.isInteger(input.maxLooks) || input.maxLooks < 1) throw new Error("invalid maxLooks");
  if (!Number.isInteger(input.currentLook) || input.currentLook < 1 || input.currentLook > input.maxLooks) throw new Error("invalid currentLook");
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error("invalid resamples");
  const differences = input.differences.filter((value) => Number.isFinite(value));
  if (differences.length !== input.differences.length || differences.length === 0) throw new Error("differences must be finite and non-empty");

  const comparisonCount = Math.max(1, input.comparisonFamily.comparisonCount);
  const alpha = 0.05 / (input.maxLooks * comparisonCount);
  const lowerQuantile = alpha / 2;
  const upperQuantile = 1 - alpha / 2;
  const means = bootstrapMeans(differences, resamples, input.seed);
  const lower = quantile(means, lowerQuantile);
  const upper = quantile(means, upperQuantile);
  const mean = average(differences);
  const practicalDifference = input.practicalDifference ?? 0;
  let verdict: ComparisonVerdict = "inconclusive";
  if (lower > practicalDifference) {
    verdict = "winner";
  } else if (Math.abs(lower) <= practicalDifference && Math.abs(upper) <= practicalDifference) {
    verdict = "tie";
  }

  return {
    comparisonId: input.comparisonId,
    mean,
    lower,
    upper,
    verdict,
    metadata: {
      familywiseAlpha: 0.05,
      maxLooks: input.maxLooks,
      currentLook: input.currentLook,
      comparisonFamilyId: input.comparisonFamily.comparisonFamilyId,
      comparisonCount,
      alpha,
      lowerQuantile,
      upperQuantile,
      frozenPairIds: [...input.comparisonFamily.frozenPairIds],
      resamples,
      seed: input.seed,
      sampleCount: differences.length,
      coverage: 1 - alpha,
    },
  };
}

export function decideValidatedSampling(input: ValidatedSamplingInput): ValidatedSamplingDecision {
  const requiredMatchedUnits = Math.max(PROTOCOL_MINIMUM_MATCHED_UNITS, input.minimumMatchedUnits ?? PROTOCOL_MINIMUM_MATCHED_UNITS);
  const base = {
    matchedUnits: input.matchedUnits,
    requiredMatchedUnits,
  };

  if (input.cancelled) return { ...base, status: "inconclusive", stopReason: "cancellation", evidenceGate: "passed" };
  if (input.failure) return { ...base, status: "inconclusive", stopReason: "failure", evidenceGate: "passed" };
  if (input.approvedMaximumMatchedUnits !== undefined && input.approvedMaximumMatchedUnits < requiredMatchedUnits) {
    return { ...base, status: "refuse", stopReason: "failure", evidenceGate: "approved-budget-too-small" };
  }

  const missingEvidenceGate = firstMissingEvidenceGate(input, requiredMatchedUnits);
  if (missingEvidenceGate) return gatedDecision(input, base, missingEvidenceGate);

  const results = input.comparisonResults ?? [];
  if (results.length === 0 || results.some((result) => !validateConsensusRevision2Metadata(result, input.matchedUnits).ok)) {
    return gatedDecision(input, base, "statistics-metadata");
  }

  if (input.budgetReached) return { ...base, status: "inconclusive", stopReason: "budget", stopDetail: input.budgetDetail, evidenceGate: "passed" };

  if (results.every((result) => result.verdict === "winner")) {
    return { ...base, status: "winner", stopReason: "confidence", evidenceGate: "passed", result: results[0] };
  }
  if (results.every((result) => result.verdict === "tie")) {
    return { ...base, status: "tie", stopReason: "confidence", evidenceGate: "passed", result: results[0] };
  }
  if (input.exhausted) return { ...base, status: "inconclusive", stopReason: "exhaustion", evidenceGate: "passed", result: results[0] };
  return { ...base, status: "continue", stopReason: null, evidenceGate: "passed", result: results[0] };
}

function firstMissingEvidenceGate(input: ValidatedSamplingInput, requiredMatchedUnits: number): ValidatedSamplingDecision["evidenceGate"] | null {
  if (input.matchedUnits < requiredMatchedUnits) return "min-matched-units";
  const requiredFamilies = input.requiredScenarioFamilies ?? [];
  for (const family of requiredFamilies) {
    if ((input.scenarioFamilyCounts?.[family] ?? 0) < 2) return "scenario-coverage";
  }
  return null;
}

function gatedDecision(
  input: ValidatedSamplingInput,
  base: Pick<ValidatedSamplingDecision, "matchedUnits" | "requiredMatchedUnits">,
  evidenceGate: ValidatedSamplingDecision["evidenceGate"],
): ValidatedSamplingDecision {
  if (input.budgetReached) return { ...base, status: "inconclusive", stopReason: "budget", stopDetail: input.budgetDetail, evidenceGate };
  if (input.exhausted) return { ...base, status: "inconclusive", stopReason: "exhaustion", evidenceGate };
  return { ...base, status: "continue", stopReason: null, evidenceGate };
}

export function validateConsensusRevision2Metadata(result: ComparisonResult, matchedUnits?: number): ConsensusRevision2Validation {
  const metadata = result.metadata;
  if (result.comparisonId.length === 0) return invalid("missing comparison id");
  if (!Number.isFinite(result.mean) || !Number.isFinite(result.lower) || !Number.isFinite(result.upper)) return invalid("non-finite interval statistics");
  const metadataCheck = validateConsensusRevision2MetadataFields(metadata, { comparisonId: result.comparisonId, matchedUnits });
  return metadataCheck.ok ? { ok: true } : metadataCheck;
}

export function validateConsensusRevision2MetadataFields(
  metadata: ConsensusRevision2Metadata,
  options: { comparisonId?: string; matchedUnits?: number } = {},
): ConsensusRevision2Validation {
  if (metadata.familywiseAlpha !== 0.05) return invalid("familywiseAlpha must be 0.05");
  if (!Number.isInteger(metadata.maxLooks) || metadata.maxLooks < 1) return invalid("maxLooks must be a positive integer");
  if (!Number.isInteger(metadata.currentLook) || metadata.currentLook < 1 || metadata.currentLook > metadata.maxLooks) return invalid("currentLook must be within maxLooks");
  if (metadata.comparisonFamilyId.length === 0) return invalid("comparisonFamilyId is required");
  if (!Array.isArray(metadata.frozenPairIds)) return invalid("frozenPairIds must be an array");
  if (new Set(metadata.frozenPairIds).size !== metadata.frozenPairIds.length) return invalid("frozenPairIds must be unique");
  if (metadata.frozenPairIds.some((pairId) => typeof pairId !== "string" || pairId.length === 0)) return invalid("frozenPairIds must be non-empty strings");
  if (options.comparisonId !== undefined && !metadata.frozenPairIds.includes(options.comparisonId)) return invalid("comparison id must be frozen");
  const expectedComparisonCount = Math.max(1, metadata.frozenPairIds.length);
  if (!Number.isInteger(metadata.comparisonCount) || metadata.comparisonCount !== expectedComparisonCount) return invalid("comparisonCount must match frozen pair count");
  const expectedAlpha = metadata.familywiseAlpha / (metadata.maxLooks * metadata.comparisonCount);
  if (!nearlyEqual(metadata.alpha, expectedAlpha)) return invalid("alpha must equal familywiseAlpha/(maxLooks*comparisonCount)");
  if (!nearlyEqual(metadata.lowerQuantile, expectedAlpha / 2)) return invalid("lowerQuantile must equal alpha/2");
  if (!nearlyEqual(metadata.upperQuantile, 1 - expectedAlpha / 2)) return invalid("upperQuantile must equal 1-alpha/2");
  if (metadata.resamples !== PROTOCOL_BOOTSTRAP_RESAMPLES) return invalid("resamples must equal 10000");
  if (metadata.seed.length === 0) return invalid("seed is required");
  if (!Number.isInteger(metadata.sampleCount) || metadata.sampleCount < PROTOCOL_MINIMUM_MATCHED_UNITS) return invalid("sampleCount must be at least 6");
  if (options.matchedUnits !== undefined && metadata.sampleCount !== options.matchedUnits) return invalid("sampleCount must match matched units");
  if (!Number.isFinite(metadata.coverage) || metadata.coverage <= 0 || metadata.coverage > 1) return invalid("coverage must be within (0, 1]");
  return { ok: true };
}

function invalid(reason: string): ConsensusRevision2Validation {
  return { ok: false, reason };
}

function nearlyEqual(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12;
}

function bootstrapMeans(values: number[], count: number, seed: string): number[] {
  const random = seededRandom(seed);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)];
    out[i] = sum / values.length;
  }
  out.sort((a, b) => a - b);
  return out;
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const pos = q * (sortedValues.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sortedValues[lower];
  const weight = pos - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function seededRandom(seed: string): () => number {
  let state = parseInt(stableHash(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
