import { describe, expect, it } from "vitest";
import {
  bindApprovalHash,
  canonicalJson,
  isApprovalBoundToSpec,
  isFreezeInvalidated,
  stableHash,
  validateEvidenceV1,
  validateRecommendationV1,
  validateRunV1,
  validateSkillBenchSpecV1,
  validateSummaryV1,
} from "../../src/skill-bench/types.js";

const validSpec = () => ({
  schemaVersion: 1,
  id: "spec-alpha",
  name: "Spec Alpha",
  status: "draft",
  executionProfile: "restricted",
  budgets: { maxUsd: 1, maxPremiumRequests: 2, maxRuntimeMs: 30_000, maxCells: 4 },
  candidateModelIds: ["gpt-5.5"],
  judgeModelIds: ["gpt-5.6-terra"],
  arms: [
    { id: "baseline", kind: "baseline" },
    { id: "skill", kind: "skill", skillId: "history-analyze" },
  ],
  scenarios: [
    {
      id: "find-regression",
      name: "Find regression",
      action: "detect-report",
      tags: ["history", "regression"],
      weight: 1,
      threshold: { min: 0, max: 1, pass: 0.7 },
    },
  ],
});

describe("skill-bench v1 type validation", () => {
  it("accepts a minimal draft spec with mandatory baseline+skill arms and optional prompt", () => {
    const promptSpec = validSpec();
    promptSpec.arms.push({ id: "prompt", kind: "prompt" });
    const result = validateSkillBenchSpecV1(promptSpec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.arms.map((arm) => arm.id)).toEqual(["baseline", "skill", "prompt"]);
  });

  it("accepts provider-qualified model ids without relaxing artifact ids", () => {
    const spec = {
      ...validSpec(),
      candidateModelIds: ["provider:model.v1"],
      judgeModelIds: ["judge:model.v1"],
    };
    expect(validateSkillBenchSpecV1(spec)).toEqual({ ok: true, value: spec });
    expect(validateSkillBenchSpecV1({ ...spec, candidateModelIds: ["provider/model"] })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(["unsafe candidate model id"]),
    });
  });

  it("fails closed on missing/duplicate ids, unsafe names, impossible budgets and thresholds", () => {
    const cases: Array<[string, unknown, string]> = [
      ["duplicate scenario", { ...validSpec(), scenarios: [validSpec().scenarios[0], validSpec().scenarios[0]] }, "duplicate scenario id"],
      ["unsafe id", { ...validSpec(), id: "../escape" }, "unsafe spec id"],
      ["unsafe name", { ...validSpec(), name: "Spec/Alpha" }, "unsafe spec name"],
      ["negative budget", { ...validSpec(), budgets: { ...validSpec().budgets, maxUsd: -1 } }, "invalid budget maxUsd"],
      ["zero weight", { ...validSpec(), scenarios: [{ ...validSpec().scenarios[0], weight: 0 }] }, "invalid scenario weight"],
      ["threshold outside range", { ...validSpec(), scenarios: [{ ...validSpec().scenarios[0], threshold: { min: 0, max: 1, pass: 2 } }] }, "impossible threshold"],
      ["candidate is judge", { ...validSpec(), judgeModelIds: ["gpt-5.5"] }, "candidate model cannot judge itself"],
      ["unknown action", { ...validSpec(), scenarios: [{ ...validSpec().scenarios[0], action: "ship" }] }, "unknown scenario action"],
      ["unknown status", { ...validSpec(), status: "running" }, "unknown spec status"],
      ["unknown profile", { ...validSpec(), executionProfile: "root" }, "unknown execution profile"],
      ["missing baseline", { ...validSpec(), arms: [{ id: "skill", kind: "skill", skillId: "x" }] }, "baseline and skill arms are mandatory"],
    ];

    for (const [, input, expected] of cases) {
      const result = validateSkillBenchSpecV1(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain(expected);
    }
  });

  it("requires every scenario to declare non-empty safe tags", () => {
    const scenario = validSpec().scenarios[0];
    const cases: Array<[string, unknown, string]> = [
      ["missing tags", { ...validSpec(), scenarios: [{ ...scenario, tags: undefined }] }, "missing scenario tags"],
      ["empty tags", { ...validSpec(), scenarios: [{ ...scenario, tags: [] }] }, "missing scenario tags"],
      ["unsafe tag", { ...validSpec(), scenarios: [{ ...scenario, tags: ["history", "../escape"] }] }, "unsafe scenario tag"],
      ["blank tag", { ...validSpec(), scenarios: [{ ...scenario, tags: ["history", ""] }] }, "unsafe scenario tag"],
      ["duplicate tag", { ...validSpec(), scenarios: [{ ...scenario, tags: ["history", "history"] }] }, "duplicate scenario tag"],
    ];

    for (const [, input, expected] of cases) {
      const result = validateSkillBenchSpecV1(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain(expected);
    }
  });

  it("requires aggregate scenario weights to total 1.0", () => {
    const scenario = validSpec().scenarios[0];
    const invalidSpec = {
      ...validSpec(),
      scenarios: [
        { ...scenario, id: "find-regression", weight: 0.6 },
        { ...scenario, id: "explain-regression", name: "Explain regression", tags: ["history", "explain"], weight: 0.3 },
      ],
    };

    const result = validateSkillBenchSpecV1(invalidSpec);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("invalid scenario weight total");
  });

  it("accepts a valid weighted scenario set with scenario tags", () => {
    const scenario = validSpec().scenarios[0];
    const weightedSpec = {
      ...validSpec(),
      scenarios: [
        { ...scenario, id: "find-regression", tags: ["history", "detect"], weight: 0.4 },
        { ...scenario, id: "plan-remediation", name: "Plan remediation", action: "plan-only", tags: ["planning"], weight: 0.6 },
      ],
    };

    const result = validateSkillBenchSpecV1(weightedSpec);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.scenarios.map((scenario) => scenario.tags)).toEqual([["history", "detect"], ["planning"]]);
  });

  it("validates run/evidence/summary/recommendation primitive statuses and actions", () => {
    expect(validateRunV1({ schemaVersion: 1, id: "run-a", specId: "spec-alpha", status: "approved", cells: [] }).ok).toBe(true);
    expect(validateEvidenceV1({ schemaVersion: 1, id: "ev-a", cellId: "cell-a", status: "parity-invalid", paths: [] }).ok).toBe(true);
    expect(validateSummaryV1({ schemaVersion: 1, id: "sum-a", runId: "run-a", status: "inconclusive", qualityWinner: null }).ok).toBe(true);
    expect(validateRecommendationV1({ schemaVersion: 1, id: "rec-a", runId: "run-a", action: "advisory", status: "stale" }).ok).toBe(true);

    expect(validateRunV1({ schemaVersion: 1, id: "run-a", specId: "spec-alpha", status: "maybe", cells: [] }).ok).toBe(false);
    expect(validateRecommendationV1({ schemaVersion: 1, id: "rec-a", runId: "run-a", action: "applied", status: "ready" }).ok).toBe(false);
  });

  it("hashes canonical JSON stably and binds approvals/freeze invalidation to semantic content", () => {
    const a = { z: 1, nested: { b: true, a: [2, 1] } };
    const b = { nested: { a: [2, 1], b: true }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(stableHash(a)).toBe(stableHash(b));
    expect(stableHash({ ...a, z: 2 })).not.toBe(stableHash(a));

    const spec = validSpec();
    const approval = bindApprovalHash(spec);
    expect(isApprovalBoundToSpec(approval, spec)).toBe(true);
    expect(isApprovalBoundToSpec(approval, { ...spec, candidateModelIds: ["gpt-6"] })).toBe(false);
    expect(isFreezeInvalidated({ specHash: approval.specHash, frozenPairIds: ["baseline__skill"] }, spec, ["baseline__skill"])).toBe(false);
    expect(isFreezeInvalidated({ specHash: approval.specHash, frozenPairIds: ["baseline__skill"] }, spec, ["baseline__skill", "baseline__prompt"])).toBe(true);
  });

  it("binds approval and freeze hashes to spec content without accumulated approvals", () => {
    const spec = validSpec();
    const onceApproved = { ...spec, approvals: [{ gateId: "selection" }] };
    const twiceApproved = { ...spec, approvals: [{ gateId: "selection" }, { gateId: "scenarios" }] };
    const approval = bindApprovalHash(onceApproved);

    expect(approval.specHash).toBe(bindApprovalHash(twiceApproved).specHash);
    expect(isApprovalBoundToSpec(approval, twiceApproved)).toBe(true);
    expect(isFreezeInvalidated({ specHash: approval.specHash }, twiceApproved)).toBe(false);
    expect(isFreezeInvalidated({ specHash: approval.specHash }, { ...twiceApproved, scenarios: [{ ...validSpec().scenarios[0], weight: 2 }] })).toBe(true);
  });

  it("keeps the semantic approval hash stable when freeze only changes lifecycle metadata", () => {
    const draft = validSpec();
    const frozen = {
      ...draft,
      status: "frozen",
      approvals: { frozen: true, budget: true, liveCellsAllowed: true },
    };

    expect(bindApprovalHash(draft).specHash).toBe(bindApprovalHash(frozen).specHash);
  });
});
