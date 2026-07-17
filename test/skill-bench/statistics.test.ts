import { describe, expect, it } from "vitest";
import {
  comparePairedDifferences,
  decideValidatedSampling,
  freezeComparisonFamily,
  protocolFingerprint,
  validateConsensusRevision2Metadata,
} from "../../src/skill-bench/statistics.js";

describe("Consensus Revision 2 statistics protocol", () => {
  it("freezes pairwise comparison ids before execution and invalidates candidate changes", () => {
    const family = freezeComparisonFamily({ comparisonFamilyId: "fam-a", armIds: ["skill", "baseline", "prompt"] });
    expect(family.frozenPairIds).toEqual(["baseline__prompt", "baseline__skill", "prompt__skill"]);
    expect(family.comparisonCount).toBe(3);
    expect(protocolFingerprint({ family, maxLooks: 2, resamples: 10_000, seed: "seed" })).not.toBe(
      protocolFingerprint({ family: freezeComparisonFamily({ comparisonFamilyId: "fam-a", armIds: ["skill", "baseline"] }), maxLooks: 2, resamples: 10_000, seed: "seed" }),
    );
  });

  it("rejects comparisons not present in the frozen family", () => {
    const family = freezeComparisonFamily({ comparisonFamilyId: "fam-a", armIds: ["baseline", "skill"] });
    expect(() =>
      comparePairedDifferences({
        comparisonId: "baseline__prompt",
        comparisonFamily: family,
        differences: [1, 1, 1, 1, 1, 1],
        maxLooks: 1,
        currentLook: 1,
        seed: "seed",
      }),
    ).toThrow(/not frozen/);
  });

  it("uses familywise alpha across looks and frozen pairwise comparisons with required metadata", () => {
    const family = freezeComparisonFamily({ comparisonFamilyId: "fam-a", armIds: ["baseline", "skill", "prompt"] });
    const result = comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: family,
      differences: [1, 1, 1, 1, 1, 1],
      maxLooks: 2,
      currentLook: 1,
      resamples: 10_000,
      seed: "spec-hash:baseline__skill",
      practicalDifference: 0.05,
    });

    expect(result.metadata.familywiseAlpha).toBe(0.05);
    expect(result.metadata.maxLooks).toBe(2);
    expect(result.metadata.currentLook).toBe(1);
    expect(result.metadata.comparisonFamilyId).toBe("fam-a");
    expect(result.metadata.comparisonCount).toBe(3);
    expect(result.metadata.alpha).toBeCloseTo(0.05 / 6, 12);
    expect(result.metadata.lowerQuantile).toBeCloseTo(0.05 / 12, 12);
    expect(result.metadata.upperQuantile).toBeCloseTo(1 - 0.05 / 12, 12);
    expect(result.metadata.frozenPairIds).toEqual(["baseline__prompt", "baseline__skill", "prompt__skill"]);
    expect(result.metadata.resamples).toBe(10_000);
    expect(result.metadata.seed).toBe("spec-hash:baseline__skill");
    expect(result.metadata.sampleCount).toBe(6);
    expect(result.metadata.coverage).toBeGreaterThan(0.99);
    expect(result.verdict).toBe("winner");
  });

  it("reduces one-rival and one-look behavior to two-sided familywise alpha 0.05", () => {
    const result = comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: freezeComparisonFamily({ comparisonFamilyId: "fam-single", armIds: ["baseline", "skill"] }),
      differences: [1, 1, 1, 1, 1, 1],
      maxLooks: 1,
      currentLook: 1,
      resamples: 10_000,
      seed: "single-look",
    });
    expect(result.metadata.alpha).toBe(0.05);
    expect(result.metadata.lowerQuantile).toBe(0.025);
    expect(result.metadata.upperQuantile).toBe(0.975);
  });

  it("makes a looks-only false winner inconclusive under complete family adjustment", () => {
    const differences = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    const looksOnly = comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: freezeComparisonFamily({ comparisonFamilyId: "fam-single", armIds: ["baseline", "skill"] }),
      differences,
      maxLooks: 2,
      currentLook: 1,
      resamples: 10_000,
      seed: "flip-vector",
      practicalDifference: 0.05,
    });
    const familyAdjusted = comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: freezeComparisonFamily({ comparisonFamilyId: "fam-three", armIds: ["baseline", "skill", "prompt"] }),
      differences,
      maxLooks: 2,
      currentLook: 1,
      resamples: 10_000,
      seed: "flip-vector",
      practicalDifference: 0.05,
    });

    expect(looksOnly.verdict).toBe("winner");
    expect(familyAdjusted.verdict).toBe("inconclusive");
    expect(familyAdjusted.metadata.alpha).toBeCloseTo(0.05 / 6, 12);
  });
});


describe("validated adaptive sampling controller", () => {
  const family = freezeComparisonFamily({ comparisonFamilyId: "fam-a", armIds: ["baseline", "skill"] });
  const winnerResult = () =>
    comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: family,
      differences: [10, 10, 10, 10, 10, 10],
      maxLooks: 2,
      currentLook: 1,
      resamples: 10_000,
      seed: "winner",
      practicalDifference: 5,
    });
  const inconclusiveResult = () =>
    comparePairedDifferences({
      comparisonId: "baseline__skill",
      comparisonFamily: family,
      differences: [0, 0, 0, 0, 10, 10],
      maxLooks: 2,
      currentLook: 1,
      resamples: 10_000,
      seed: "inconclusive",
      practicalDifference: 5,
    });

  it("stops with confidence only after minimum matched units coverage and complete Consensus Revision 2 metadata", () => {
    expect(
      decideValidatedSampling({
        matchedUnits: 6,
        scenarioFamilyCounts: { normal: 2, edge: 2, adversarial: 2 },
        requiredScenarioFamilies: ["normal", "edge", "adversarial"],
        comparisonResults: [winnerResult()],
      }),
    ).toMatchObject({ status: "winner", stopReason: "confidence", evidenceGate: "passed", matchedUnits: 6, requiredMatchedUnits: 6 });
  });

  it("uses budget stop family with ceiling detail before overclaiming confidence", () => {
    expect(
      decideValidatedSampling({
        matchedUnits: 6,
        comparisonResults: [winnerResult()],
        budgetReached: true,
        budgetDetail: "premium-ceiling",
      }),
    ).toMatchObject({ status: "inconclusive", stopReason: "budget", stopDetail: "premium-ceiling" });
  });

  it("returns exhaustion cancellation and failure stop families", () => {
    expect(decideValidatedSampling({ matchedUnits: 6, comparisonResults: [inconclusiveResult()], exhausted: true })).toMatchObject({
      status: "inconclusive",
      stopReason: "exhaustion",
    });
    expect(decideValidatedSampling({ matchedUnits: 6, comparisonResults: [winnerResult()], cancelled: true })).toMatchObject({
      status: "inconclusive",
      stopReason: "cancellation",
    });
    expect(decideValidatedSampling({ matchedUnits: 6, comparisonResults: [winnerResult()], failure: true })).toMatchObject({
      status: "inconclusive",
      stopReason: "failure",
    });
  });

  it("fails closed below six matched baseline-plus-skill units", () => {
    expect(decideValidatedSampling({ matchedUnits: 5, comparisonResults: [winnerResult()] })).toMatchObject({
      status: "continue",
      stopReason: null,
      evidenceGate: "min-matched-units",
      requiredMatchedUnits: 6,
    });
    expect(decideValidatedSampling({ matchedUnits: 5, comparisonResults: [winnerResult()], budgetReached: true, budgetDetail: "cell-ceiling" })).toMatchObject({
      status: "inconclusive",
      stopReason: "budget",
      evidenceGate: "min-matched-units",
    });
    expect(decideValidatedSampling({ matchedUnits: 0, approvedMaximumMatchedUnits: 5 })).toMatchObject({
      status: "refuse",
      stopReason: "failure",
      evidenceGate: "approved-budget-too-small",
    });
  });

  it("fails closed when scenario coverage or statistics metadata is incomplete", () => {
    expect(
      decideValidatedSampling({
        matchedUnits: 6,
        scenarioFamilyCounts: { normal: 2, edge: 1 },
        requiredScenarioFamilies: ["normal", "edge"],
        comparisonResults: [winnerResult()],
      }),
    ).toMatchObject({ status: "continue", evidenceGate: "scenario-coverage" });

    const missingMetadata = { ...winnerResult(), metadata: { ...winnerResult().metadata, coverage: Number.NaN } };
    expect(decideValidatedSampling({ matchedUnits: 6, comparisonResults: [missingMetadata], budgetReached: true })).toMatchObject({
      status: "inconclusive",
      stopReason: "budget",
      evidenceGate: "statistics-metadata",
    });
  });

  it("rejects malformed Consensus Revision 2 alpha quantile frozen-pair and sample metadata", () => {
    const malformedAlpha = { ...winnerResult(), metadata: { ...winnerResult().metadata, alpha: 0.05 / 6 } };
    expect(validateConsensusRevision2Metadata(malformedAlpha, 6).ok).toBe(false);
    expect(decideValidatedSampling({ matchedUnits: 6, comparisonResults: [malformedAlpha], budgetReached: true })).toMatchObject({
      status: "inconclusive",
      stopReason: "budget",
      evidenceGate: "statistics-metadata",
    });

    const malformedQuantiles = { ...winnerResult(), metadata: { ...winnerResult().metadata, lowerQuantile: 0.025, upperQuantile: 0.975 } };
    expect(validateConsensusRevision2Metadata(malformedQuantiles, 6).ok).toBe(false);

    const malformedFrozenPairs = { ...winnerResult(), metadata: { ...winnerResult().metadata, comparisonCount: 2, frozenPairIds: ["baseline__skill", "dynamic__skill"] } };
    expect(validateConsensusRevision2Metadata(malformedFrozenPairs, 6).ok).toBe(false);

    const malformedSampleCount = { ...winnerResult(), metadata: { ...winnerResult().metadata, sampleCount: 5 } };
    expect(validateConsensusRevision2Metadata(malformedSampleCount, 6).ok).toBe(false);
  });

  it("accepts valid Consensus Revision 2 winner metadata", () => {
    expect(validateConsensusRevision2Metadata(winnerResult(), 6)).toEqual({ ok: true });
  });
});
