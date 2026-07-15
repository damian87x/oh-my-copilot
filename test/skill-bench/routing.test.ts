import { describe, expect, it } from "vitest";
import {
  buildRoutingCapabilityProtocolV1,
  planSkillBenchRouteApply,
  preflightSkillBenchExport,
  renderAdvisoryInstructionBlock,
  resolveSkillBenchRoute,
} from "../../src/skill-bench/routing.js";

const recommendation = () => ({
  schemaVersion: 1 as const,
  id: "rec-alpha",
  runId: "run-alpha",
  validated: true,
  humanApprovedPolicy: null,
  scope: "project" as const,
  taskMatcher: "history-analyze",
  selectedSkill: { id: "history-analyze", fingerprint: "skill-fp" },
  selectedModel: { id: "gpt-5.5", fingerprint: "model-fp" },
  fingerprints: { spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp", pricing: "price-fp" },
  confidence: { verdict: "winner" as const, samples: 12, scenarioCoverage: "6/6" },
  evidencePath: "runs/run-alpha/summary.json",
});

describe("skill-bench routing capability protocol v1", () => {
  it("labels enforced/advisory/unsupported exactly and only enforces OMP-owned captured routes", () => {
    const entries = buildRoutingCapabilityProtocolV1({
      recommendation: recommendation(),
      surfaces: [
        { surface: "omp-headless", provider: "omp", ownedLaunch: true, supportsEnforcedRoute: true, capturedEffectiveRoute: { skillId: "history-analyze", modelId: "gpt-5.5", evidencePath: "routes/omp-effective.json" } },
        { surface: "copilot-interactive", provider: "copilot", ownedLaunch: false, supportsEnforcedRoute: false, capturedEffectiveRoute: null },
        { surface: "custom-provider", provider: "custom", ownedLaunch: false, supportsEnforcedRoute: false, unsupportedReason: "no routing API" },
      ],
    });

    expect(entries).toEqual([
      { surface: "omp-headless", capability: "enforced", reason: "OMP-owned launch captured effective route", desiredRoute: { skillId: "history-analyze", modelId: "gpt-5.5" }, effectiveRoute: { skillId: "history-analyze", modelId: "gpt-5.5" }, verified: true, verificationEvidence: "routes/omp-effective.json" },
      { surface: "copilot-interactive", capability: "advisory", reason: "Copilot interactive v1 cannot be enforced after session start", desiredRoute: { skillId: "history-analyze", modelId: "gpt-5.5" }, effectiveRoute: null, verified: false, verificationEvidence: null },
      { surface: "custom-provider", capability: "unsupported", reason: "no routing API", desiredRoute: { skillId: "history-analyze", modelId: "gpt-5.5" }, effectiveRoute: null, verified: false, verificationEvidence: null },
    ]);
  });

  it("does not verify or enforce a non-dry-run route from matching fingerprints alone", () => {
    const plan = planSkillBenchRouteApply({
      recommendation: recommendation(),
      dryRun: false,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [],
    });

    expect(plan.verified).toBe(false);
    expect(plan.enforced).toBe(false);
    expect(plan.disabledReason).toContain("effective route");
    expect(plan.mutations).toEqual([]);
  });

  it("enforces non-dry-run route only with verified OMP-owned effective-route evidence", () => {
    const entries = buildRoutingCapabilityProtocolV1({
      recommendation: recommendation(),
      surfaces: [
        { surface: "omp-headless", provider: "omp", ownedLaunch: true, supportsEnforcedRoute: true, capturedEffectiveRoute: { skillId: "history-analyze", modelId: "gpt-5.5", evidencePath: "routes/omp-effective.json" } },
      ],
    });

    const plan = planSkillBenchRouteApply({
      recommendation: recommendation(),
      dryRun: false,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [],
      routingCapabilities: entries,
    });

    expect(plan.verified).toBe(true);
    expect(plan.enforced).toBe(true);
    expect(plan.disabledReason).toBeNull();
    expect(plan.mutations).toEqual([]);
  });

  it("plans a real Copilot advisory write without claiming enforcement and fails closed on conflicts", () => {
    const copilotEntries = buildRoutingCapabilityProtocolV1({
      recommendation: recommendation(),
      surfaces: [
        { surface: "copilot-interactive", provider: "copilot", ownedLaunch: false, supportsEnforcedRoute: false, capturedEffectiveRoute: null },
      ],
    });

    const advisory = planSkillBenchRouteApply({
      recommendation: recommendation(),
      dryRun: false,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [],
      routingCapabilities: copilotEntries,
    });

    expect(advisory.verified).toBe(false);
    expect(advisory.enforced).toBe(false);
    expect(advisory.disabledReason).toBeNull();
    expect(advisory.mutations).toEqual([
      "write project advisory route for history-analyze",
    ]);

    const enforcedEntries = buildRoutingCapabilityProtocolV1({
      recommendation: recommendation(),
      surfaces: [
        { surface: "omp-headless", provider: "omp", ownedLaunch: true, supportsEnforcedRoute: true, capturedEffectiveRoute: { skillId: "history-analyze", modelId: "gpt-5.5", evidencePath: "routes/omp-effective.json" } },
      ],
    });
    const conflict = planSkillBenchRouteApply({
      recommendation: recommendation(),
      dryRun: false,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [{ scope: "project", taskMatcher: "history-analyze", skillId: "old-skill", modelId: "gpt-4.1", source: "project-config" }],
      routingCapabilities: enforcedEntries,
    });

    expect(conflict.verified).toBe(false);
    expect(conflict.enforced).toBe(false);
    expect(conflict.disabledReason).toContain("conflicting route");
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.mutations).toEqual([]);
  });

  it("plans dry-run conflicts/staleness/scope precedence and marker-bounded idempotent advisory blocks", () => {
    const stale = planSkillBenchRouteApply({
      recommendation: recommendation(),
      dryRun: true,
      currentFingerprints: { skill: "new-skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [
        { scope: "project", taskMatcher: "history-analyze", skillId: "old-skill", modelId: "gpt-4.1", source: "project-config" },
        { scope: "global", taskMatcher: "history-analyze", skillId: "global-skill", modelId: "gpt-5-mini", source: "global-config" },
      ],
      requestedScope: "project",
      explicitBypass: false,
    });

    expect(stale.verified).toBe(false);
    expect(stale.enforced).toBe(false);
    expect(stale.disabledReason).toContain("stale fingerprint");
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.precedence).toEqual(["explicit task", "project", "global", "host default"]);
    expect(stale.mutations).toEqual([]);
    expect(stale.memoryUsedAsSourceOfTruth).toBe(false);

    const block1 = renderAdvisoryInstructionBlock(recommendation());
    const block2 = renderAdvisoryInstructionBlock(recommendation(), `before\n${block1}\nafter`);
    expect(block2.match(/BEGIN OMP SKILL-BENCH ROUTE/g)).toHaveLength(1);
    expect(block2).toContain("Recommended skill: history-analyze");
    expect(block2).toContain("Recommended model: gpt-5.5");
    expect(() =>
      renderAdvisoryInstructionBlock(
        recommendation(),
        "<!-- BEGIN OMP SKILL-BENCH ROUTE -->\ntruncated",
      ),
    ).toThrow(/marker/i);
  });

  it("generates recommendation only from validated evidence or explicit human tie policy and discloses bypass", () => {
    expect(() => planSkillBenchRouteApply({ recommendation: { ...recommendation(), validated: false, confidence: { verdict: "pilot", samples: 1, scenarioCoverage: "1/6" } }, dryRun: true, currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" }, existingRules: [] })).toThrow(/validated evidence/);

    const inconclusive = planSkillBenchRouteApply({
      recommendation: { ...recommendation(), validated: false, humanApprovedPolicy: "prefer cheapest among tied passing cells", confidence: { verdict: "inconclusive", samples: 12, scenarioCoverage: "6/6" } },
      dryRun: true,
      explicitBypass: true,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
      existingRules: [],
    });
    expect(inconclusive.bypassDisclosed).toBe(true);
    expect(inconclusive.disabledReason).toBeNull();
  });

  it("resolves route precedence without memory and rejects unsafe export bundles before publication", () => {
    const route = resolveSkillBenchRoute({
      taskMatcher: "history-analyze",
      explicitTaskRoute: null,
      projectRules: [{ scope: "project", taskMatcher: "history-analyze", skillId: "project-skill", modelId: "gpt-5.5", source: "project-config" }],
      globalRules: [{ scope: "global", taskMatcher: "history-analyze", skillId: "global-skill", modelId: "gpt-5-mini", source: "global-config" }],
    });
    expect(route).toMatchObject({ skillId: "project-skill", source: "project-config" });

    const unsafe = preflightSkillBenchExport({
      files: [
        { path: "spec.json", content: "ok" },
        { path: "raw.txt", content: "RAW_PROMPT_SENTINEL session-019f500e-22c3-7653-861b-46db21203491 /Users/damianborek/workspace/secret sk-live-123" },
        { path: "link", content: "", symlinkTarget: "/tmp/outside" },
      ],
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.errors.join("\n")).toContain("raw prompt/output sentinel");
    expect(unsafe.errors.join("\n")).toContain("session id");
    expect(unsafe.errors.join("\n")).toContain("absolute private path");
    expect(unsafe.errors.join("\n")).toContain("secret");
    expect(unsafe.errors.join("\n")).toContain("unresolved symlink");
  });
});
