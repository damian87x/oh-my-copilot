import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRegisteredCommand, registeredCommandHelpLines } from "../../src/commands/registry.js";
import { setSkillBenchModelProbeForTests } from "../../src/commands/skill-bench.js";
import { freezeReviewedManifestV1 } from "../../src/skill-bench/design.js";
import {
  REQUIRED_EVIDENCE_ARTIFACTS,
  setSkillBenchProviderTransportForTests,
} from "../../src/skill-bench/execute.js";
import { setSkillBenchPricingResolverForTests } from "../../src/skill-bench/pricing.js";

const cwd = "/repo";

async function run(args: string[], json = false, runCwd = cwd) {
  const command = findRegisteredCommand("skill-bench");
  expect(command).toBeTruthy();
  return await command!.run(args, { cwd: runCwd, json });
}

async function approvePortableExport(
  id: string,
  output: string,
  json = false,
  runCwd = cwd,
) {
  const preview = await run(
    ["skill-bench", "export", id, "--output", output],
    json,
    runCwd,
  );
  expect(preview).toMatchObject({ ok: true });
  return await run(
    ["skill-bench", "export", id, "--output", output, "--approve"],
    json,
    runCwd,
  );
}

function tempCwd() {
  return mkdtempSync(path.join(tmpdir(), "omp-skill-bench-cmd-"));
}

function writeJson(root: string, relativePath: string, value: unknown) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  const specMatch = /^\.omp\/skill-bench\/specs\/([^/]+)\/manifest\.json$/.exec(relativePath);
  if (specMatch && value && typeof value === "object" && (value as { status?: unknown }).status === "frozen") {
    const ledgerPath = path.join(root, ".omp", "skill-bench", "specs", specMatch[1], "approvals.jsonl");
    if (!existsSync(ledgerPath)) appendApprovalLedger(root, specMatch[1], value as Record<string, unknown>);
  }
  const runMatch = /^\.omp\/skill-bench\/runs\/([^/]+)\/run\.json$/.exec(relativePath);
  if (runMatch && value && typeof value === "object") {
    const binding = (value as { sourceApproval?: { specContentHash?: unknown } }).sourceApproval;
    if (typeof binding?.specContentHash === "string") {
      writeFileSync(
        path.join(root, ".omp", "skill-bench", "runs", runMatch[1], "approvals.jsonl"),
        approvalLedgerText(binding.specContentHash),
      );
    }
  }
}

function writeSkill(root: string, slug: string, name = slug) {
  const dir = path.join(root, ".github", "skills", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test ${name} skill.\n---\n\n# ${name}\n`,
  );
  return dir;
}

function writeUserSkill(home: string, slug: string, name = slug) {
  const dir = path.join(home, ".copilot", "skills", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: User ${name} skill.\n---\n\n# ${name}\n`,
  );
  return dir;
}

function writePluginSkill(home: string, plugin: string, slug: string, name = slug) {
  const dir = path.join(home, ".copilot", "installed-plugins", plugin, ".github", "skills", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Plugin ${name} skill.\n---\n\n# ${name}\n`,
  );
  return dir;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Directory(directory: string) {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const entryPath = path.join(current, entry);
      if (existsSync(entryPath) && readFileSync) {
        const stat = lstatSync(entryPath);
        if (stat.isDirectory()) visit(entryPath);
        else if (stat.isFile()) files.push(entryPath);
      }
    }
  };
  visit(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value: unknown) {
  return sha256Text(canonicalJson(value));
}

function specContentHash(spec: Record<string, unknown>) {
  const content = { ...spec } as Record<string, unknown>;
  delete content.approvals;
  delete content.approvalLedger;
  delete content.status;
  return sha256Json(content);
}

function appendApprovalLedger(root: string, specId: string, spec: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const manifestHash = specContentHash(spec);
  const ledgerPath = path.join(root, ".omp", "skill-bench", "specs", specId, "approvals.jsonl");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  for (const gateId of ["selection", "scenarios", "action-contract", "references", "rubric", "models", "execution-profile", "budgets"]) {
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ schemaVersion: 1, type: "approval", gateId, specContentHash: manifestHash, approved: true, approvedAt: "2026-07-14T00:00:00.000Z", ...overrides })}\n`,
      { flag: "a" },
    );
  }
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ schemaVersion: 1, type: "freeze", specContentHash: manifestHash, status: "frozen", approvedAt: "2026-07-14T00:00:01.000Z", ...overrides })}\n`,
    { flag: "a" },
  );
}

function approvalLedgerText(specHash: string): string {
  return [
    ...["selection", "scenarios", "action-contract", "references", "rubric", "models", "execution-profile", "budgets"].map((gateId) =>
      JSON.stringify({ schemaVersion: 1, type: "approval", gateId, specContentHash: specHash, approved: true, approvedAt: "2026-07-14T00:00:00.000Z" }),
    ),
    JSON.stringify({ schemaVersion: 1, type: "freeze", specContentHash: specHash, status: "frozen", approvedAt: "2026-07-14T00:00:01.000Z" }),
  ].join("\n") + "\n";
}

function appendAdjacentApprovalLedger(manifestPath: string, spec: Record<string, unknown>) {
  const manifestHash = specContentHash(spec);
  const ledgerPath = path.join(path.dirname(manifestPath), "approvals.jsonl");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  for (const gateId of ["selection", "scenarios", "action-contract", "references", "rubric", "models", "execution-profile", "budgets"]) {
    writeFileSync(ledgerPath, `${JSON.stringify({ schemaVersion: 1, type: "approval", gateId, specContentHash: manifestHash, approved: true })}\n`, { flag: "a" });
  }
  writeFileSync(ledgerPath, `${JSON.stringify({ schemaVersion: 1, type: "freeze", specContentHash: manifestHash, status: "frozen" })}\n`, { flag: "a" });
}

function writeApprovedSpec(root: string, specId: string, spec: Record<string, unknown>) {
  writeJson(root, `.omp/skill-bench/specs/${specId}/manifest.json`, spec);
}

function writeEvaluator(root: string, source: string) {
  const evaluatorPath = path.join(root, ".omp", "skill-bench", "evaluators", `eval-${sha256Text(source).slice(0, 8)}.mjs`);
  mkdirSync(path.dirname(evaluatorPath), { recursive: true });
  writeFileSync(evaluatorPath, source);
  return evaluatorPath;
}

function attachEvaluator(root: string, spec: Record<string, unknown>, source: string) {
  const evaluatorPath = writeEvaluator(root, source);
  return {
    ...spec,
    evaluation: {
      schemaVersion: 1,
      command: [process.execPath, evaluatorPath],
      evaluator: {
        schemaVersion: 1,
        path: evaluatorPath,
        sha256: sha256File(evaluatorPath),
        provenance: "test-fixture",
        approvedRoot: root,
      },
    },
  };
}

function providerSpecWithEvaluator(root: string, id = "live-ok", extra: Record<string, unknown> = {}) {
  return attachEvaluator(root, {
    ...approvedSpec(id),
    provider: { kind: "copilot", approved: true },
    skill: { id: "dynamic-review", fingerprint: "skill-fp-live" },
    execution: { allowlistedTools: ["view"] },
    budgets: {
      ...approvedSpec(id).budgets,
      estimatedCellUsd: 0.01,
      estimatedCellPremiumRequests: 1,
    },
    fingerprint: { status: "current", skill: "skill-fp-live", model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
    ...extra,
  }, `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const response = readFileSync(input.declaredEvidence[0].path, 'utf8');
    process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: response.includes('found issue') ? 1 : 0, proofMatrix: { expected: ['find issue'], found: response.includes('found issue') ? ['find issue'] : [], done: response.includes('found issue') ? ['find issue'] : [], missed: response.includes('found issue') ? [] : ['find issue'], falsePositive: [], incorrect: [], proof: [input.declaredEvidence[0].path] }, evidence: [{ path: input.declaredEvidence[0].path }] }));
  `);
}

function withoutKeys<T extends Record<string, unknown>>(value: T, keys: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

async function withHome<T>(home: string, callback: () => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await callback();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

function approvedSpec(id = "spec-ok") {
  return {
    schemaVersion: 1,
    id,
    name: id,
    status: "frozen",
    executionProfile: "restricted",
    budgets: { maxUsd: 1, maxCells: 12, maxRuntimeMs: 120000, maxPremiumRequests: 12 },
    candidateModelIds: ["model-a"],
    judgeModelIds: ["judge-a"],
    arms: [
      { id: "baseline", kind: "baseline" },
      { id: "skill", kind: "skill", skillId: "dynamic-review" },
    ],
    scenarios: [
      {
        id: "normal",
        name: "normal case",
        action: "detect-report",
        tags: ["normal"],
        weight: 1,
        threshold: { min: 0, max: 1, pass: 0.5 },
      },
    ],
    approvals: { frozen: true, budget: true, liveCellsAllowed: true },
    recommendation: { valid: true, selected: "code-review" },
    fingerprint: { status: "current" },
    conflicts: { status: "clear" },
    evidence: { status: "verified" },
  };
}

function frozenSourceSpec(id = "spec-source") {
  return {
    schemaVersion: 1,
    id,
    name: id,
    status: "frozen",
    executionProfile: "restricted",
    budgets: { maxUsd: 1, maxCells: 12, maxRuntimeMs: 120000, maxPremiumRequests: 12 },
    candidateModelIds: ["model-a"],
    judgeModelIds: ["judge-a"],
    arms: [
      { id: "baseline", kind: "baseline" },
      { id: "skill", kind: "skill", skillId: "dynamic-review" },
    ],
    scenarios: [],
    approvals: { frozen: true, budget: true, liveCellsAllowed: false },
    fingerprint: { status: "current" },
  };
}
function syntheticSpec(id = "spec-synth") {
  const scenarios = [
    { id: "normal", name: "normal case", title: "normal case", action: "detect-report", tags: ["normal"], weight: 1 / 3, threshold: { min: 0, max: 1, pass: 0.5 }, expected: ["find issue"] },
    { id: "edge", name: "edge case", title: "edge case", action: "detect-report", tags: ["edge"], weight: 1 / 3, threshold: { min: 0, max: 1, pass: 0.5 }, expected: ["avoid false positive"] },
    { id: "regression", name: "regression case", title: "regression case", action: "detect-report", tags: ["regression"], weight: 1 / 3, threshold: { min: 0, max: 1, pass: 0.5 }, expected: ["preserve behavior"] },
  ];
  const armIds = ["baseline", "skill"];
  const arms = [
    { id: "baseline", kind: "baseline" },
    { id: "skill", kind: "skill", skillId: "dynamic-review" },
  ];
  const models = ["model-a", "model-b"];
  return {
    ...approvedSpec(id),
    synthetic: true,
    skill: { id: "dynamic-review" },
    taskMatcher: "dynamic-review-task",
    scenarios,
    candidateModelIds: models,
    arms,
    models,
    deterministicEvaluatorResults: deterministicResults(scenarios, armIds, models),
    fingerprint: { status: "current", skill: "skill-fp-dyn", model: "model-fp-dyn", spec: "spec-fp-dyn", evaluation: "eval-fp-dyn", provider: "provider-fp-dyn" },
  };
}

function deterministicResults(
  scenarios: Array<{ id: string; title: string; expected: string[] }>,
  arms: string[],
  models: string[],
) {
  return scenarios.flatMap((scenario) =>
    models.flatMap((modelId) =>
      arms.map((arm) => ({
        scenarioId: scenario.id,
        modelId,
        arm,
        qualityScore: arm === "skill" ? 1 : 0,
        proofMatrix: {
          expected: scenario.expected,
          found: arm === "skill" ? scenario.expected : [],
          done: arm === "skill" ? scenario.expected : [],
          missed: arm === "skill" ? [] : scenario.expected,
          falsePositive: [],
          incorrect: [],
          proof: [],
        },
      })),
    ),
  );
}

function insufficientSyntheticSpec(id = "spec-insufficient") {
  const scenarios = [{ id: "single", name: "single case", title: "single case", action: "detect-report", tags: ["single"], weight: 1, threshold: { min: 0, max: 1, pass: 0.5 }, expected: ["find issue"] }];
  const armIds = ["baseline", "skill"];
  const arms = [
    { id: "baseline", kind: "baseline" },
    { id: "skill", kind: "skill", skillId: "dynamic-review" },
  ];
  const models = ["model-a"];
  return {
    ...syntheticSpec(id),
    scenarios,
    arms,
    models,
    candidateModelIds: models,
    deterministicEvaluatorResults: deterministicResults(scenarios, armIds, models),
  };
}

function completedRun(id = "run-ok", sourceId = "spec-ok", evidenceSha256 = "missing-evidence-sha") {
  const recommendation = routingRecommendation(id);
  const sourceSpecHash = "source-spec-hash";
  return {
    schemaVersion: 1,
    id,
    sourceId,
    sourceApproval: {
      specContentHash: sourceSpecHash,
      ledgerSha256: sha256Text(approvalLedgerText(sourceSpecHash)),
    },
    mode: "pilot",
    status: "completed",
    approvals: { frozen: true, budget: true, liveCellsAllowed: true },
    recommendation,
    fingerprint: { status: "current" },
    conflicts: { status: "clear" },
    evidence: { status: "verified" },
    reportPath: `.omp/skill-bench/runs/${id}/sweep_report.html`,
    currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
    routingCapabilities: [
      {
        surface: "omp-headless",
        capability: "enforced",
        reason: "OMP-owned launch captured effective route",
        desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
        effectiveRoute: { skillId: "code-review", modelId: "gpt-test" },
        verified: true,
        verificationEvidence: `.omp/skill-bench/runs/${id}/route-evidence.json`,
        verificationEvidenceSha256: evidenceSha256,
      },
    ],
    existingRules: [],
    exportManifest: { files: [`.omp/skill-bench/runs/${id}/run.json`] },
  };
}


function routeEvidenceFor(runId = "run-ok") {
  const recommendation = routingRecommendation(runId);
  return {
    schemaVersion: 1,
    runId,
    recommendationSha256: sha256Json(recommendation),
    desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
    effectiveRoute: { skillId: "code-review", modelId: "gpt-test" },
  };
}

function writeCompletedRunWithEvidence(root: string, id = "run-ok", sourceId = "spec-ok") {
  const evidence = routeEvidenceFor(id);
  const evidenceContent = `${JSON.stringify(evidence, null, 2)}\n`;
  writeJson(root, `.omp/skill-bench/runs/${id}/run.json`, completedRun(id, sourceId, sha256Text(evidenceContent)));
  const evidencePath = path.join(root, `.omp/skill-bench/runs/${id}/route-evidence.json`);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, evidenceContent);
}

function routingRecommendation(runId = "run-ok") {
  return {
    schemaVersion: 1,
    id: `rec-${runId}`,
    runId,
    action: "advisory",
    status: "ready",
    validated: true,
    humanApprovedPolicy: null,
    scope: "project",
    taskMatcher: "code-review",
    selectedSkill: { id: "code-review", fingerprint: "skill-fp" },
    selectedModel: { id: "gpt-test", fingerprint: "model-fp" },
    fingerprints: { spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
    confidence: { verdict: "winner", samples: 6, scenarioCoverage: "2/2" },
    evidencePath: `.omp/skill-bench/runs/${runId}/summary.json`,
  };
}

describe("skill-bench command", () => {
  beforeEach(() => {
    setSkillBenchPricingResolverForTests(async () => null);
  });

  afterEach(() => {
    setSkillBenchPricingResolverForTests(null);
  });

  it("is registered with the public grammar", () => {
    const command = findRegisteredCommand("skill-bench");
    expect(command?.name).toBe("skill-bench");
    expect(registeredCommandHelpLines().join("\n")).toContain("skill-bench [<skill-or-path>]");
    expect(registeredCommandHelpLines().join("\n")).toContain("run <spec-id-or-path> --pilot|--validated");
    expect(registeredCommandHelpLines().join("\n")).toContain("export <spec-id-or-run-id>");
  });

  it("stamps current fingerprint status when freezing reviewed manifests", () => {
    const frozen = freezeReviewedManifestV1({
      id: "freeze-fingerprint",
      fingerprint: {
        status: "stale",
        skill: "skill-fp",
        model: "model-fp",
        spec: "spec-fp",
        evaluation: "eval-fp",
        provider: "provider-fp",
      },
    });

    expect(frozen).toMatchObject({
      status: "frozen",
      fingerprint: {
        status: "current",
        skill: "skill-fp",
        model: "model-fp",
        spec: "spec-fp",
        evaluation: "eval-fp",
        provider: "provider-fp",
      },
    });
  });

  it("rejects non-synthetic import when allowlisted tools or hard budget ceilings are missing or blank", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "empty-allowlist",
        {
          ...providerSpecWithEvaluator(root, "import-contract-empty-allowlist", {
            skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
            execution: { allowlistedTools: [] },
            budgets: {
              maxUsd: 1,
              maxCells: 12,
              maxRuntimeMs: 120000,
              maxPremiumRequests: 12,
              estimatedCellUsd: 0.01,
              estimatedCellPremiumRequests: 1,
            },
            fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
          }),
          budgets: {
            maxUsd: 1,
            maxCells: 12,
            maxRuntimeMs: 120000,
            maxPremiumRequests: 12,
            estimatedCellUsd: 0.01,
            estimatedCellPremiumRequests: 1,
          },
        },
        "allowlistedTools",
      ],
      [
        "blank-allowlist",
        {
          ...providerSpecWithEvaluator(root, "import-contract-blank-allowlist", {
            skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
            execution: { allowlistedTools: ["   "] },
            budgets: {
              maxUsd: 1,
              maxCells: 12,
              maxRuntimeMs: 120000,
              maxPremiumRequests: 12,
              estimatedCellUsd: 0.01,
              estimatedCellPremiumRequests: 1,
            },
            fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
          }),
          budgets: {
            maxUsd: 1,
            maxCells: 12,
            maxRuntimeMs: 120000,
            maxPremiumRequests: 12,
            estimatedCellUsd: 0.01,
            estimatedCellPremiumRequests: 1,
          },
        },
        "allowlistedTools",
      ],
      [
        "missing-hard-ceiling",
        {
          ...providerSpecWithEvaluator(root, "import-contract-missing-hard-ceiling", {
            skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
            execution: { allowlistedTools: ["view"] },
            budgets: {
              maxUsd: 1,
              maxRuntimeMs: 120000,
              maxPremiumRequests: 12,
              estimatedCellUsd: 0.01,
              estimatedCellPremiumRequests: 1,
            },
            fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
          }),
          budgets: {
            maxUsd: 1,
            maxRuntimeMs: 120000,
            maxPremiumRequests: 12,
            estimatedCellUsd: 0.01,
            estimatedCellPremiumRequests: 1,
          },
        },
        "explicit hard budget ceilings",
      ],
    ];

    for (const [label, manifest, expected] of cases) {
      writeJson(root, `manifest-${label}.json`, manifest);
      const draftId = `import-contract-${label}`;
      writeJson(root, `.omp/skill-bench/drafts/${draftId}/design.json`, {
        phase: "design",
        mode: "guided",
        id: draftId,
        approvals: { frozen: false, budget: false, liveCellsAllowed: false },
        importedManifest: manifest,
      });

      await expect(run(["skill-bench", "resume", draftId, "--import", `./manifest-${label}.json`], false, root)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining(expected),
      });
    }
  });

  it("dispatches guided and direct design to persisted draft artifacts without Python or installed benchmark paths", async () => {
    const root = tempCwd();
    writeSkill(root, "custom-review");
    writeSkill(root, "history-analyze");
    const guided = await run(["skill-bench", "--window", "7d", "--project", "current", "--scope", "project", "--advanced"], false, root);
    expect(guided).toMatchObject({ ok: true });
    expect(guided.message).toContain("Guided skill-bench draft saved");
    expect(guided.message).toContain("history window=7d project=current");
    expect(guided.message).toContain("resume: omp skill-bench resume");
    expect(guided.message).toMatch(/draft-id=guided-[a-f0-9]{12}/);
    const guidedDraftId = /draft-id=(guided-[a-f0-9]{12})/.exec(guided.message ?? "")?.[1];
    expect(guidedDraftId).toBeTruthy();
    const guidedDraftPath = path.join(root, ".omp/skill-bench/drafts", guidedDraftId!, "design.json");
    expect(existsSync(guidedDraftPath)).toBe(true);
    expect(JSON.parse(readFileSync(guidedDraftPath, "utf8"))).toMatchObject({
      id: guidedDraftId,
      phase: "design",
      mode: "guided",
      filters: { window: "7d", project: "current" },
      approvals: { frozen: false, budget: false, liveCellsAllowed: false },
      skills: { candidates: expect.arrayContaining([expect.objectContaining({ name: "custom-review", canonicalPath: expect.stringContaining("custom-review"), fingerprint: expect.any(String) })]) },
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/drafts", guidedDraftId!, "approvals.jsonl"))).toBe(true);

    const direct = await run(["skill-bench", ".github/skills/custom-review"], false, root);
    expect(direct).toMatchObject({ ok: true });
    expect(direct.message).toContain("Direct skill-bench draft saved");
    expect(direct.message).toContain("skill=.github/skills/custom-review");
    expect(direct.message).toMatch(/draft-id=direct-[a-f0-9]{12}/);
    const directDraftId = /draft-id=(direct-[a-f0-9]{12})/.exec(direct.message ?? "")?.[1];
    expect(directDraftId).toBeTruthy();
    expect(existsSync(path.join(root, ".omp/skill-bench/drafts", directDraftId!, "design.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/drafts", directDraftId!, "design.json"), "utf8"))).toMatchObject({
      skills: { selected: [expect.objectContaining({ name: "custom-review", sourceKind: "explicit", canonicalPath: expect.stringContaining("custom-review"), sourceUri: expect.stringContaining("SKILL.md"), provenance: expect.any(Object) })] },
    });

    expect(`${guided.message}\n${direct.message}`).not.toMatch(/python3?|benchmarks\/skill-bench/);
  });

  it("preserves duplicate guided candidates by identity/path for explicit conversational selection", async () => {
    const root = tempCwd();
    const home = tempCwd();
    writeSkill(root, "project-review", "shared-review");
    writeUserSkill(home, "user-review", "shared-review");
    writePluginSkill(home, "plugin-one", "plugin-review", "shared-review");

    await withHome(home, async () => {
      const result = await run(["skill-bench"], false, root);
      expect(result).toMatchObject({ ok: true });
      const draftId = /draft-id=(guided-[a-f0-9]{12})/.exec(
        result.message ?? "",
      )?.[1];
      expect(draftId).toBeTruthy();
      const draft = JSON.parse(
        readFileSync(
          path.join(root, ".omp", "skill-bench", "drafts", draftId!, "design.json"),
          "utf8",
        ),
      );
      expect(draft.skills.selected).toEqual([]);
      expect(draft.skills.duplicates).toEqual([
        expect.objectContaining({
          name: "shared-review",
          candidates: expect.arrayContaining([
            expect.objectContaining({ canonicalPath: expect.stringContaining("project-review") }),
            expect.objectContaining({ canonicalPath: expect.stringContaining("user-review") }),
            expect.objectContaining({ canonicalPath: expect.stringContaining("plugin-review") }),
          ]),
        }),
      ]);
      expect(draft.next).toMatchObject({
        action: "select-skill-identity",
        candidateCount: 3,
      });
    });
  });

  it("persists plugin skill roots and dynamic model source provenance in public command drafts", async () => {
    const root = tempCwd();
    const home = tempCwd();
    writePluginSkill(home, "installed-pack", "plugin-review");
    writeJson(root, ".omp/config.json", {
      memoryReviewModel: "configured-review-model",
      skillBenchModelCandidates: ["configured-bench-model"],
      skillBenchProviderSnapshots: [
        { url: "https://provider.example/models", date: "2026-07-14", modelIds: ["provider-model"] },
      ],
    });

    await withHome(home, async () => {
      const result = await run(["skill-bench", "plugin-review"], false, root);
      expect(result).toMatchObject({ ok: true });
      const draftId = /draft-id=(direct-[a-f0-9]{12})/.exec(result.message ?? "")?.[1];
      const draft = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/drafts", draftId!, "design.json"), "utf8"));
      expect(draft.skills.selected).toEqual([
        expect.objectContaining({ name: "plugin-review", sourceKind: "plugin", fingerprint: expect.any(String) }),
      ]);
      expect(draft.models.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "configured-review-model", sources: ["configured"] }),
          expect.objectContaining({ id: "configured-bench-model", sources: ["configured"] }),
          expect.objectContaining({ id: "auto", sources: ["host-default"] }),
          expect.objectContaining({ id: "provider-model", sources: ["provider-snapshot"] }),
        ]),
      );
      expect(draft.models.provenance).toContain("provider snapshot https://provider.example/models @ 2026-07-14");
    });
  });

  it("probes only explicit model ids after opt-in and keeps unknown models selectable", async () => {
    const root = tempCwd();
    writeSkill(root, "custom-review");
    const probed: string[][] = [];
    setSkillBenchModelProbeForTests(async (modelIds) => {
      probed.push(modelIds);
      return modelIds.map((model) => ({
        model,
        status: model === "explicit-fast" ? "available" as const : "unknown" as const,
      }));
    });
    try {
      const unprobed = await run(
        ["skill-bench", "custom-review", "--model", "explicit-fast"],
        true,
        root,
      );
      expect(unprobed).toMatchObject({
        ok: true,
        output: {
          models: {
            probeRequested: false,
            candidates: expect.arrayContaining([
              expect.objectContaining({
                id: "explicit-fast",
                probeStatus: "unknown",
                selectable: true,
              }),
            ]),
          },
        },
      });
      expect(probed).toEqual([]);

      const optedIn = await run(
        [
          "skill-bench",
          "custom-review",
          "--model",
          "explicit-fast",
          "--model",
          "explicit-new",
          "--probe-models",
        ],
        true,
        root,
      );
      expect(probed).toEqual([["explicit-fast", "explicit-new"]]);
      expect(optedIn).toMatchObject({
        ok: true,
        output: {
          models: {
            selectedModelIds: ["explicit-fast", "explicit-new"],
            probeRequested: true,
            probeTargets: ["explicit-fast", "explicit-new"],
            candidates: expect.arrayContaining([
              expect.objectContaining({
                id: "explicit-fast",
                probeStatus: "available",
                selectable: true,
              }),
              expect.objectContaining({
                id: "explicit-new",
                probeStatus: "unknown",
                selectable: true,
              }),
            ]),
          },
        },
      });
    } finally {
      setSkillBenchModelProbeForTests(null);
    }

    await expect(
      run(["skill-bench", "custom-review", "--probe-models"], false, root),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("--probe-models requires at least one --model"),
    });
  });

  it("fails closed when an explicit model id is marked unavailable", async () => {
    const root = tempCwd();
    writeSkill(root, "custom-review");
    writeJson(root, ".omp/config.json", { skillBenchUnavailableModels: ["blocked-model"] });

    await expect(run(["skill-bench", "custom-review", "--model", "blocked-model"], false, root)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("Explicit skill-bench model is unavailable: blocked-model"),
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/drafts"))).toBe(false);
  });

  it("fails closed when direct skill names are ambiguous duplicates", async () => {
    const root = tempCwd();
    writeSkill(root, "one-review", "dupe-review");
    writeSkill(root, "two-review", "dupe-review");

    await expect(run(["skill-bench", "dupe-review"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("ambiguous"),
    });
  });

  it("persists reviewed model, judge, execution profile, and hard budget selections in command drafts", async () => {
    const root = tempCwd();
    writeSkill(root, "custom-review");
    const guided = await run(
      [
        "skill-bench",
        "--window",
        "90d",
        "--model",
        "gpt-5.5",
        "--model",
        "gpt-5.6-luna",
        "--judge-model",
        "judge:model.v1",
        "--execution-profile",
        "normal-project",
        "--max-usd",
        "12.5",
        "--max-cells",
        "24",
        "--max-runtime-minutes",
        "45",
        "--max-premium-requests",
        "3",
      ],
      false,
      root,
    );
    expect(guided).toMatchObject({ ok: true });
    const guidedDraftId = /draft-id=(guided-[a-f0-9]{12})/.exec(guided.message ?? "")?.[1];
    expect(guidedDraftId).toBeTruthy();
    expect(guided.message).toContain("execution-profile=normal-project");
    expect(guided.message).toContain("models=gpt-5.5,gpt-5.6-luna judges=judge:model.v1");
    expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/drafts", guidedDraftId!, "design.json"), "utf8"))).toMatchObject({
      mode: "guided",
      models: {
        candidateModelIds: expect.arrayContaining(["gpt-5.5", "gpt-5.6-luna"]),
        selectedModelIds: ["gpt-5.5", "gpt-5.6-luna"],
        judgeModelIds: ["judge:model.v1"],
      },
      executionProfile: "normal-project",
      hardBudgetCeilings: { maxUsd: 12.5, maxCells: 24, maxRuntimeMinutes: 45, maxPremiumRequests: 3 },
    });

    const direct = await run(["skill-bench", ".github/skills/custom-review", "--model", "gpt-safe", "--judge-model", "judge-safe", "--execution-profile", "custom", "--max-usd", "1"], false, root);
    const directDraftId = /draft-id=(direct-[a-f0-9]{12})/.exec(direct.message ?? "")?.[1];
    expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/drafts", directDraftId!, "design.json"), "utf8"))).toMatchObject({
      mode: "direct",
      skillOrPath: ".github/skills/custom-review",
      models: { candidateModelIds: expect.arrayContaining(["gpt-safe"]), selectedModelIds: ["gpt-safe"], judgeModelIds: ["judge-safe"] },
      executionProfile: "custom",
      hardBudgetCeilings: { maxUsd: 1 },
    });
  });

  it("runs the public design lifecycle through import, append-only gate approvals, freeze, evaluator-backed run, and report", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const fixtureDir = path.join(root, "review-fixture");
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(path.join(fixtureDir, "input.txt"), "approved fixture\n");
    const imported = attachEvaluator(root, {
      ...approvedSpec("imported-review"),
      status: "draft",
      approvals: { frozen: false, budget: false, liveCellsAllowed: false },
      provider: { kind: "copilot", approved: true },
      fingerprint: undefined,
      candidateModelIds: ["provider:model.v1"],
      judgeModelIds: ["judge:model.v1"],
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      execution: { allowlistedTools: ["view"] },
      budgets: { maxUsd: 1, maxCells: 12, maxRuntimeMs: 120000, maxPremiumRequests: 12, estimatedCellUsd: 0.02, estimatedCellPremiumRequests: 1 },
      scenarios: [
        {
          id: "normal",
          name: "normal case",
          action: "detect-report",
          tags: ["normal"],
          weight: 1,
          threshold: { min: 0, max: 1, pass: 0.5 },
          expected: ["find issue"],
          fixturePath: fixtureDir,
          visibleFixtureFingerprint: sha256Directory(fixtureDir),
        },
      ],
    }, `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const response = readFileSync(input.declaredEvidence[0].path, 'utf8');
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        label: 'answer-quality',
        score: response.includes('found issue') ? 1 : 0,
        proofMatrix: { expected: ['find issue'], found: response.includes('found issue') ? ['find issue'] : [], done: response.includes('found issue') ? ['find issue'] : [], missed: response.includes('found issue') ? [] : ['find issue'], falsePositive: [], incorrect: [], proof: [input.declaredEvidence[0].path] },
        evidence: [{ path: input.declaredEvidence[0].path }]
      }));
    `);
    writeJson(root, "review-manifest.json", imported);

    const direct = await run(["skill-bench", ".github/skills/dynamic-review", "--model", "model-a", "--judge-model", "judge-a", "--max-usd", "1", "--max-premium-requests", "4"], false, root);
    const draftId = /draft-id=(direct-[a-f0-9]{12})/.exec(direct.message ?? "")?.[1];
    expect(draftId).toBeTruthy();

    await expect(run(["skill-bench", "resume", draftId!, "--import", "review-manifest.json"], false, root)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("imported reviewed manifest"),
    });
    for (const gate of ["selection", "scenarios", "action-contract", "references", "rubric", "models", "execution-profile", "budgets"]) {
      await expect(run(["skill-bench", "resume", draftId!, "--approve", gate], false, root)).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining(`approved gate ${gate}`),
      });
    }
    await expect(run(["skill-bench", "resume", draftId!, "--approve", "selection"], false, root)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("append-only"),
    });
    const frozen = await run(["skill-bench", "resume", draftId!, "--freeze"], false, root);
    expect(frozen).toMatchObject({ ok: true, message: expect.stringContaining("frozen spec exported") });
    const specId = /spec-id=(\S+)/.exec(frozen.message ?? "")?.[1];
    expect(specId).toBeTruthy();
    const frozenManifestPath = path.join(
      root,
      ".omp/skill-bench/specs",
      specId!,
      "manifest.json",
    );
    const frozenManifestText = readFileSync(frozenManifestPath, "utf8");
    const frozenManifest = JSON.parse(frozenManifestText);
    expect(frozenManifest).toMatchObject({
      status: "frozen",
      approvals: { frozen: true, budget: true, liveCellsAllowed: false },
      skill: { path: "bundle/skill" },
      evaluation: {
        command: ["node", "bundle/evaluator.mjs"],
        evaluator: { path: "bundle/evaluator.mjs", approvedRoot: "bundle" },
      },
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/specs", specId!, "approvals.jsonl"))).toBe(true);
    expect(existsSync(path.join(root, ".omp/skill-bench/specs", specId!, "bundle/skill/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, ".omp/skill-bench/specs", specId!, "bundle/evaluator.mjs"))).toBe(true);
    writeFileSync(path.join(skillDir, "SKILL.md"), "mutated after freeze\n");

    const calls: Array<{ skillId: string | null; exposurePath?: string; status?: string; isolated: boolean }> = [];
    setSkillBenchProviderTransportForTests(async (request) => {
      calls.push({
        skillId: request.skillExposure.selectedSkillId,
        exposurePath: request.skillExposure.exposurePath,
        status: existsSync(path.join(request.workspacePath, ".github", "skills", "dynamic-review", "SKILL.md")) ? "staged" : "missing",
        isolated: path.relative(root, request.workspacePath).startsWith(".."),
      });
      return {
        status: "complete",
        stdout: request.skillExposure.selectedSkillId ? "found issue" : "missed",
        stderr: "",
        exitCode: 0,
      };
    });
    try {
      await expect(run(["skill-bench", "run", specId!, "--pilot"], false, root)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("live-cell approval required"),
      });
      expect(calls).toEqual([]);
      const result = await run(["skill-bench", "run", specId!, "--pilot", "--approve-spend"], false, root);
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining("pilot provider run completed") });
      expect(calls).toEqual([
        { skillId: null, exposurePath: undefined, status: "missing", isolated: true },
        { skillId: "dynamic-review", exposurePath: expect.stringContaining(".github/skills/dynamic-review"), status: "staged", isolated: true },
      ]);
      const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
      expect(readFileSync(path.join(root, ".omp/skill-bench/specs", specId!, "approvals.jsonl"), "utf8")).toContain('"type":"spend-approval"');
      expect(readFileSync(frozenManifestPath, "utf8")).toBe(
        frozenManifestText,
      );
      const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));
      expect(runArtifact.reportInput.cells.map((cell: { qualityScore: number }) => cell.qualityScore)).toEqual([0, 1]);
      expect(runArtifact.reportInput.budget).toMatchObject({
        maxUsd: 1,
        maxCells: 12,
        maxRuntimeMs: 120000,
        maxPremiumRequests: 12,
        spentUsd: null,
        premiumRequests: null,
        actualTelemetryCompleteness: "unknown",
        estimateProvenance: "approved-conservative-per-cell",
      });
      await expect(run(["skill-bench", "report", runId!, "--no-open"], false, root)).resolves.toMatchObject({ ok: true });
      expect(existsSync(path.join(root, ".omp/skill-bench/runs", runId!, "approvals.jsonl"))).toBe(true);
      await expect(approvePortableExport(runId!, "provider-export.json", false, root)).resolves.toMatchObject({ ok: true });
      const portableRun = JSON.parse(
        readFileSync(path.join(root, "provider-export.json"), "utf8"),
      );
      expect(JSON.stringify(portableRun)).not.toContain(root);
      const exportedPaths = new Set(
        portableRun.files.map((file: { path: string }) => file.path),
      );
      for (const cell of runArtifact.reportInput.cells as Array<{
        evidencePaths: string[];
      }>) {
        for (const evidencePath of cell.evidencePaths) {
          expect(exportedPaths.has(evidencePath), evidencePath).toBe(true);
        }
      }
      await expect(run(["skill-bench", "rerun", runId!], false, root)).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining("fingerprint check ready"),
      });
      writeFileSync(
        path.join(root, ".omp/skill-bench/specs", specId!, "bundle/fixtures/normal/input.txt"),
        "mutated frozen fixture\n",
      );
      await expect(run(["skill-bench", "rerun", runId!], false, root)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("stale spec"),
      });
      rmSync(path.join(root, ".omp/skill-bench/runs", runId!, "approvals.jsonl"));
      await expect(run(["skill-bench", "report", runId!, "--no-open"], false, root)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("approval ledger"),
      });
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("accepts legacy frozen specs when freeze only added fingerprint freshness after approval", async () => {
    const root = tempCwd();
    const id = "legacy-freeze-fingerprint";
    const skillDir = writeSkill(root, "dynamic-review");
    const preFreeze = {
      ...withoutKeys(
        providerSpecWithEvaluator(root, id, {
          candidateModelIds: ["model-a", "model-b"],
          skill: {
            id: "dynamic-review",
            path: skillDir,
            fingerprint: sha256Directory(skillDir),
          },
        }),
        ["fingerprint"],
      ),
      status: "draft",
      approvals: { frozen: false, budget: false, liveCellsAllowed: false },
    };
    const approvedHash = specContentHash(preFreeze);
    const frozen = freezeReviewedManifestV1(preFreeze);
    const manifestPath = `.omp/skill-bench/specs/${id}/manifest.json`;
    writeJson(root, manifestPath, frozen);
    writeFileSync(
      path.join(root, ".omp", "skill-bench", "specs", id, "approvals.jsonl"),
      approvalLedgerText(approvedHash),
    );

    await expect(
      run(["skill-bench", "run", id, "--pilot"], false, root),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("live-cell approval required"),
    });

    setSkillBenchProviderTransportForTests(async (request) => ({
      status: "complete",
      stdout: request.skillExposure.selectedSkillId ? "found issue" : "",
      stderr: "",
      exitCode: 0,
    }));
    try {
      const result = await run(
        ["skill-bench", "run", id, "--pilot", "--approve-spend"],
        false,
        root,
      );
      expect(result).toMatchObject({
        ok: true,
        message: expect.stringContaining("pilot provider run completed"),
      });
      const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
      const runArtifact = JSON.parse(
        readFileSync(
          path.join(root, ".omp", "skill-bench", "runs", runId!, "run.json"),
          "utf8",
        ),
      );
      expect(runArtifact.sourceApproval.specContentHash).toBe(approvedHash);
      expect(runArtifact.cells).toHaveLength(4);
      expect(new Set(runArtifact.cells.map((cell: { id: string }) => cell.id)).size).toBe(4);
      for (const cell of runArtifact.cells as Array<{ id: string }>) {
        expect(
          existsSync(
            path.join(
              root,
              ".omp",
              "skill-bench",
              "runs",
              runId!,
              "cells",
              cell.id,
              "result.json",
            ),
          ),
        ).toBe(true);
      }
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("supports resume, freeze/run/report/apply/export flows with persisted approved artifacts", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/drafts/draft-1/design.json", { ...approvedSpec("draft-1"), phase: "design", mode: "guided" });
    writeJson(root, ".omp/skill-bench/specs/spec-ok/manifest.json", syntheticSpec("spec-ok"));
    writeJson(root, ".omp/skill-bench/specs/source-only/manifest.json", frozenSourceSpec("source-only"));
    writeCompletedRunWithEvidence(root, "run-ok");
    writeFileSync(path.join(root, ".omp/skill-bench/runs/run-ok/sweep_report.html"), "<html>existing report</html>\n");

    await expect(run(["skill-bench", "resume", "draft-1"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("Resumed skill-bench draft draft-1") });
    const pilotMessage = await run(["skill-bench", "run", "spec-ok", "--pilot"], false, root);
    expect(pilotMessage).toMatchObject({ ok: true, message: expect.stringContaining("pilot synthetic run completed") });
    const pilotRunId = /run-id=(\S+)/.exec(pilotMessage.message ?? "")?.[1];
    expect(pilotRunId).toBeTruthy();
    expect(existsSync(path.join(root, ".omp/skill-bench/runs", pilotRunId!, "run.json"))).toBe(true);
    expect(existsSync(path.join(root, ".omp/skill-bench/runs", pilotRunId!, "sweep_report.html"))).toBe(true);
    expect(existsSync(path.join(root, ".omp/skill-bench/runs", pilotRunId!, "cells", "normal-model-a-baseline", "request.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", pilotRunId!, "run.json"), "utf8"))).toMatchObject({ status: "completed", synthetic: true, zeroSpend: true, mode: "pilot" });
    const validatedMessage = await run(["skill-bench", "run", "spec-ok", "--validated"], false, root);
    expect(validatedMessage).toMatchObject({ ok: true, message: expect.stringContaining("validated synthetic run completed") });
    const validatedRunId = /run-id=(\S+)/.exec(validatedMessage.message ?? "")?.[1];
    expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", validatedRunId!, "run.json"), "utf8"))).toMatchObject({ status: "completed", synthetic: true, zeroSpend: true, mode: "validated", recommendation: { validated: true } });
    await expect(run(["skill-bench", "run", "source-only", "--pilot"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("missing scenarios") });
    await expect(run(["skill-bench", "report", "run-ok", "--no-open"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining(".omp/skill-bench/runs/run-ok/sweep_report.html") });
    const rerunResult = await run(["skill-bench", "rerun", "run-ok"], false, root);
    expect(rerunResult).toMatchObject({ ok: true, message: expect.stringContaining("rerun prepared") });
    const rerunPlanPath = /plan: (\S+)/.exec(rerunResult.message ?? "")?.[1];
    expect(rerunPlanPath).toBeTruthy();
    expect(JSON.parse(readFileSync(path.join(root, rerunPlanPath!), "utf8"))).toMatchObject({ phase: "rerun", sourceRunId: "run-ok", status: "ready", fingerprintCheck: "ready" });
    await expect(run(["skill-bench", "apply", "run-ok"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("verified=true") });
    await expect(run(["skill-bench", "apply", "run-ok", "--dry-run"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("verified=false") });
    await expect(approvePortableExport("run-ok", "bundle.json", false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("bundle.json") });
    expect(JSON.parse(readFileSync(path.join(root, "bundle.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      phase: "export",
      id: "run-ok",
      artifactKind: "run",
      includedFiles: [`.omp/skill-bench/runs/run-ok/run.json`],
      bundleType: "skill-bench-json-v1",
      files: [
        {
          path: `.omp/skill-bench/runs/run-ok/run.json`,
          encoding: "base64",
          content: expect.any(String),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
  });

  it("previews portable exports without writing, requires approval, and rejects stale previews", async () => {
    const root = tempCwd();
    const runId = "run-export-approval";
    writeCompletedRunWithEvidence(root, runId);
    const notePath = path.join(root, ".omp", "skill-bench", "runs", runId, "note.txt");
    writeFileSync(notePath, "reviewed export note\n");
    const runPath = path.join(root, ".omp", "skill-bench", "runs", runId, "run.json");
    const artifact = JSON.parse(readFileSync(runPath, "utf8"));
    artifact.exportManifest.files.push(`.omp/skill-bench/runs/${runId}/note.txt`);
    writeFileSync(runPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const outputPath = path.join(root, "approved-export.json");
    await expect(
      run(
        ["skill-bench", "export", runId, "--output", "approved-export.json", "--approve"],
        true,
        root,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("preview required"),
    });

    const preview = await run(
      ["skill-bench", "export", runId, "--output", "approved-export.json"],
      true,
      root,
    );
    expect(preview).toMatchObject({
      ok: true,
      output: {
        phase: "export-preview",
        exportId: expect.stringMatching(/^export-[a-f0-9]{12}$/),
        approvalRequired: true,
        includedFiles: expect.arrayContaining([
          expect.objectContaining({
            path: `.omp/skill-bench/runs/${runId}/run.json`,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
          expect.objectContaining({
            path: `.omp/skill-bench/runs/${runId}/note.txt`,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ]),
        redactions: [],
      },
    });
    expect(existsSync(outputPath)).toBe(false);

    writeFileSync(notePath, "changed after preview\n");
    await expect(
      run(
        ["skill-bench", "export", runId, "--output", "approved-export.json", "--approve"],
        true,
        root,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("preview is stale"),
    });
    expect(existsSync(outputPath)).toBe(false);

    const refreshed = await run(
      ["skill-bench", "export", runId, "--output", "approved-export.json"],
      true,
      root,
    );
    const exportId = (refreshed.output as { exportId: string }).exportId;
    const approved = await run(
      ["skill-bench", "export", runId, "--output", "approved-export.json", "--approve"],
      true,
      root,
    );
    expect(approved).toMatchObject({
      ok: true,
      output: { phase: "export", id: runId, exportId },
    });
    expect(existsSync(outputPath)).toBe(true);
    const approvalLedger = readFileSync(
      path.join(root, ".omp", "skill-bench", "exports", exportId, "approvals.jsonl"),
      "utf8",
    );
    expect(approvalLedger).toContain('"type":"export-approval"');
  });

  it("rejects malformed V1 specs through the public loader before run execution", async () => {
    const root = tempCwd();
    const malformed = approvedSpec("malformed-v1");
    delete (malformed as Record<string, unknown>).name;
    writeJson(root, ".omp/skill-bench/specs/malformed-v1/manifest.json", malformed);

    await expect(run(["skill-bench", "run", "malformed-v1", "--pilot"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("Skill-bench spec malformed-v1 is malformed"),
    });
  });

  it("rejects non-synthetic reviewed manifests that omit the live manifest contract before import", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const evaluatorPath = writeEvaluator(root, `console.log('ok');`);
    const baseManifest = {
      schemaVersion: 1,
      id: "import-contract",
      name: "import contract",
      status: "draft",
      executionProfile: "restricted",
      budgets: { maxUsd: 1, maxCells: 1, maxRuntimeMs: 120000, maxPremiumRequests: 1 },
      execution: { allowlistedTools: ["view"] },
      candidateModelIds: ["model-a"],
      judgeModelIds: ["judge-a"],
      arms: [
        { id: "baseline", kind: "baseline" },
        { id: "skill", kind: "skill", skillId: "dynamic-review" },
      ],
      scenarios: [
        {
          id: "normal",
          name: "normal case",
          action: "detect-report",
          tags: ["normal"],
          weight: 1,
          threshold: { min: 0, max: 1, pass: 0.5 },
        },
      ],
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      evaluation: {
        schemaVersion: 1,
        command: [process.execPath, evaluatorPath],
        evaluator: {
          schemaVersion: 1,
          path: evaluatorPath,
          sha256: sha256File(evaluatorPath),
          provenance: "test-fixture",
          approvedRoot: root,
        },
      },
    };

    const draft = await run(["skill-bench", "dynamic-review"], false, root);
    const draftId = /draft-id=(direct-[a-f0-9]{12})/.exec(draft.message ?? "")?.[1];
    expect(draftId).toBeTruthy();

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["provider-approval", { ...baseManifest, provider: { kind: "copilot", approved: false } }, "approved provider transport required"],
      ["missing-evaluator", { ...baseManifest, provider: { kind: "copilot", approved: true }, evaluation: { ...baseManifest.evaluation, command: [] } }, "frozen evaluator descriptor required"],
      ["missing-estimates", { ...baseManifest, provider: { kind: "copilot", approved: true }, budgets: { ...baseManifest.budgets, estimatedCellUsd: undefined, estimatedCellPremiumRequests: undefined } }, "approved conservative per-cell estimates required"],
    ];

    for (const [label, manifest, expected] of cases) {
      const manifestPath = `${label}.json`;
      writeFileSync(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(run(["skill-bench", "resume", draftId!, "--import", manifestPath], false, root)).resolves.toMatchObject({
        ok: false,
        exitCode: 1,
        message: expect.stringContaining(expected),
      });
    }
  });

  it("prefers provider-backed execution for non-synthetic specs instead of silently falling back to synthetic", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const spec = attachEvaluator(root, {
      ...approvedSpec("provider-preferred"),
      approvals: { frozen: true, budget: true, liveCellsAllowed: false },
      provider: { kind: "copilot", approved: true },
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      execution: { allowlistedTools: ["view"] },
      budgets: {
        ...approvedSpec("provider-preferred").budgets,
        estimatedCellUsd: 0.01,
        estimatedCellPremiumRequests: 1,
      },
      fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
    }, `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: { expected: ['find issue'], found: ['find issue'], done: ['find issue'], missed: [], falsePositive: [], incorrect: [], proof: [input.declaredEvidence[0].path] }, evidence: [{ path: input.declaredEvidence[0].path }] }));
    `);
    writeApprovedSpec(root, "provider-preferred", spec);
    setSkillBenchProviderTransportForTests(async (request) => ({
      status: "complete",
      stdout: request.skillExposure.selectedSkillId ? "found issue" : "",
      stderr: "",
      exitCode: 0,
      usage: { premiumRequests: 1, inputTokens: 10, outputTokens: 5, completeness: "provider-metadata", provenance: "fake-provider" },
    }));
    try {
      const result = await run(["skill-bench", "run", "provider-preferred", "--pilot", "--approve-spend"], false, root);
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining("pilot provider run completed") });
      const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
      const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));
      expect(runArtifact).toMatchObject({ status: "complete", synthetic: false, mode: "pilot" });
      expect(runArtifact.provider).toMatchObject({ kind: "copilot" });
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("blocks freeze earlier when a non-synthetic reviewed manifest lacks an approved provider", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const evaluatorPath = writeEvaluator(root, `console.log('ok');`);
    const reviewedManifestPath = path.join(root, "reviewed-manifest.json");
    writeFileSync(reviewedManifestPath, `${JSON.stringify({
      schemaVersion: 1,
      id: "imported-no-provider",
      name: "imported no provider",
      status: "draft",
      executionProfile: "restricted",
      budgets: { maxUsd: 1, maxCells: 1, maxRuntimeMs: 120000, maxPremiumRequests: 1 },
      candidateModelIds: ["model-a"],
      judgeModelIds: ["judge-a"],
      arms: [
        { id: "baseline", kind: "baseline" },
        { id: "skill", kind: "skill", skillId: "dynamic-review" },
      ],
      scenarios: [
        {
          id: "normal",
          name: "normal case",
          action: "detect-report",
          tags: ["normal"],
          weight: 1,
          threshold: { min: 0, max: 1, pass: 0.5 },
        },
      ],
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      evaluation: {
        schemaVersion: 1,
        command: [process.execPath, evaluatorPath],
        evaluator: {
          schemaVersion: 1,
          path: evaluatorPath,
          sha256: sha256File(evaluatorPath),
          provenance: "test-fixture",
          approvedRoot: root,
        },
      },
    }, null, 2)}\n`);

    const draft = await run(["skill-bench", "dynamic-review"], false, root);
    expect(draft).toMatchObject({ ok: true });
    const draftId = /draft-id=(direct-[a-f0-9]{12})/.exec(draft.message ?? "")?.[1];
    expect(draftId).toBeTruthy();

    await expect(run(["skill-bench", "resume", draftId!, "--import", "reviewed-manifest.json"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("approved provider transport required"),
    });
  });

  it("automatically snapshots public pricing for approved live runs without embedded rates", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const spec = attachEvaluator(root, {
      ...approvedSpec("live-ok"),
      provider: { kind: "copilot", approved: true },
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      execution: { allowlistedTools: ["view"] },
      arms: [
        ...approvedSpec("live-ok").arms,
        { id: "prompt", kind: "prompt", prompt: "Find and report the issue." },
      ],
      budgets: {
        ...approvedSpec("live-ok").budgets,
        estimatedCellUsd: 0.01,
        estimatedCellPremiumRequests: 1,
      },
      fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
    }, `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const response = readFileSync(input.declaredEvidence[0].path, 'utf8');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: response.includes('found issue') ? 1 : 0, proofMatrix: { expected: ['find issue'], found: response.includes('found issue') ? ['find issue'] : [], done: response.includes('found issue') ? ['find issue'] : [], missed: response.includes('found issue') ? [] : ['find issue'], falsePositive: [], incorrect: [], proof: [input.declaredEvidence[0].path] }, evidence: [{ path: input.declaredEvidence[0].path }] }));
    `);
    writeApprovedSpec(root, "live-ok", spec);
    setSkillBenchPricingResolverForTests(async () => ({
      source: "public-github-copilot-model-pricing",
      url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
      apiUrl: "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing",
      retrievedAt: "2026-07-15T12:00:00Z",
      currency: "USD",
      completeness: "unambiguous-model-rates",
      models: {
        "model-a": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      },
      unresolvedTieredModels: [],
    }));
    const calls: Array<{ modelId: string; skillId: string | null; prompt: string | null }> = [];
    setSkillBenchProviderTransportForTests(async (request) => {
      calls.push({ modelId: request.modelId, skillId: request.skillExposure.selectedSkillId, prompt: request.skillExposure.prompt });
      return {
        status: "complete",
        stdout: request.skillExposure.selectedSkillId || request.skillExposure.prompt ? "found issue" : "",
        stderr: "",
        exitCode: 0,
        usage: { premiumRequests: 1, inputTokens: 10, outputTokens: 5, completeness: "provider-metadata", provenance: "fake-provider" },
      };
    });
    try {
      const result = await run(["skill-bench", "run", "live-ok", "--pilot", "--approve-spend"], false, root);
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining("pilot provider run completed") });
      expect(calls).toEqual([
        { modelId: "model-a", skillId: null, prompt: null },
        { modelId: "model-a", skillId: "dynamic-review", prompt: null },
        { modelId: "model-a", skillId: null, prompt: "Find and report the issue." },
      ]);
      const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
      const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));
      expect(runArtifact).toMatchObject({ status: "complete", synthetic: false, mode: "pilot", provider: { kind: "copilot" } });
      expect(runArtifact.evidence).toEqual({ status: "verified" });
      expect(runArtifact.reportInput.pricing).toMatchObject({ source: "public-github-copilot-model-pricing", url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing", currency: "USD" });
      expect(runArtifact.reportInput.cells.map((cell: { costUsd: number | null }) => cell.costUsd)).toEqual([0.00002, 0.00002, 0.00002]);
      expect(runArtifact.reportInput.cells.every((cell: { tokens: { costProvenance?: string } }) => cell.tokens.costProvenance === "public-price-snapshot")).toBe(true);
      expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "pricing.json"), "utf8"))).toMatchObject({
        source: "public-github-copilot-model-pricing",
        models: { "model-a": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      });
      for (const proof of runArtifact.reportView.proofMatrices as Array<{ cellId: string }>) {
        const cellRoot = path.join(root, ".omp/skill-bench/runs", runId!, "cells", proof.cellId);
        for (const artifact of REQUIRED_EVIDENCE_ARTIFACTS) {
          expect(existsSync(path.join(cellRoot, artifact)), `${proof.cellId} missing ${artifact}`).toBe(true);
        }
      }
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("preflights the frozen evaluator contract before any provider spend", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const spec = attachEvaluator(root, {
      ...approvedSpec("invalid-evaluator-contract"),
      approvals: {
        frozen: true,
        budget: true,
        liveCellsAllowed: false,
      },
      provider: { kind: "copilot", approved: true },
      skill: {
        id: "dynamic-review",
        path: skillDir,
        fingerprint: sha256Directory(skillDir),
      },
      execution: { allowlistedTools: ["view"] },
      budgets: {
        ...approvedSpec("invalid-evaluator-contract").budgets,
        estimatedCellUsd: 0.01,
        estimatedCellPremiumRequests: 1,
      },
    }, `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'scenario-specific-label', score: 0, proofMatrix: { expected: [], found: [], done: [], missed: [], falsePositive: [], incorrect: [], proof: [input.declaredEvidence[0].path] }, evidence: [{ path: input.declaredEvidence[0].path }] }));
    `);
    writeApprovedSpec(root, "invalid-evaluator-contract", spec);
    const specRoot = path.join(
      root,
      ".omp",
      "skill-bench",
      "specs",
      "invalid-evaluator-contract",
    );
    const manifestPath = path.join(specRoot, "manifest.json");
    const ledgerPath = path.join(specRoot, "approvals.jsonl");
    const manifestBefore = readFileSync(manifestPath, "utf8");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");
    let providerCalls = 0;
    setSkillBenchProviderTransportForTests(async () => {
      providerCalls += 1;
      return {
        status: "complete",
        stdout: "found issue",
        stderr: "",
        exitCode: 0,
      };
    });
    try {
      const result = await run(
        [
          "skill-bench",
          "run",
          "invalid-evaluator-contract",
          "--pilot",
          "--approve-spend",
        ],
        false,
        root,
      );

      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining(
          "evaluator contract preflight failed before provider spend: unknown label",
        ),
      });
      expect(providerCalls).toBe(0);
      expect(readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("rejects duplicate effective models before any provider spend", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const skillFingerprint = sha256Directory(skillDir);
    const spec = providerSpecWithEvaluator(root, "duplicate-models", {
      candidateModelIds: ["model-a", "model-a"],
      skill: {
        id: "dynamic-review",
        path: skillDir,
        fingerprint: skillFingerprint,
      },
      fingerprint: {
        status: "current",
        skill: skillFingerprint,
        model: "model-fp-live",
        spec: "spec-fp-live",
        evaluation: "eval-fp-live",
        provider: "provider-fp-live",
      },
    });
    writeApprovedSpec(root, "duplicate-models", spec);
    let providerCalls = 0;
    setSkillBenchProviderTransportForTests(async () => {
      providerCalls += 1;
      return {
        status: "complete",
        stdout: "found issue",
        stderr: "",
        exitCode: 0,
      };
    });
    try {
      const result = await run(
        [
          "skill-bench",
          "run",
          "duplicate-models",
          "--pilot",
          "--approve-spend",
        ],
        false,
        root,
      );

      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining("duplicate approved model ids"),
      });
      expect(providerCalls).toBe(0);
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("backfills an unknown-cost report from public pricing without another provider call", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const spec = providerSpecWithEvaluator(root, "price-refresh", {
      candidateModelIds: ["mai-code-1-flash-picker"],
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
    });
    writeApprovedSpec(root, "price-refresh", spec);
    let providerCalls = 0;
    setSkillBenchProviderTransportForTests(async (request) => {
      providerCalls += 1;
      return {
        status: "complete",
        stdout: request.skillExposure.selectedSkillId ? "found issue" : "",
        stderr: "",
        exitCode: 0,
        usage: {
          premiumRequests: 1,
          inputTokens: 3_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 0,
          outputTokens: 500,
          completeness: "provider-session-json",
          provenance: "fake-provider",
        },
      };
    });
    try {
      const result = await run(["skill-bench", "run", "price-refresh", "--pilot", "--approve-spend"], false, root);
      const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
      expect(runId).toBeTruthy();
      expect(providerCalls).toBe(2);
      expect(JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8")).reportInput.cells.every((cell: { costUsd: number | null }) => cell.costUsd === null)).toBe(true);

      setSkillBenchPricingResolverForTests(async () => ({
        source: "public-github-copilot-model-pricing",
        url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
        apiUrl: "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing",
        retrievedAt: "2026-07-15T12:00:00Z",
        currency: "USD",
        completeness: "unambiguous-model-rates",
        models: {
          "mai-code-1-flash": { inputUsdPerMillion: 0.75, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
        },
        unresolvedTieredModels: [],
      }));
      await expect(run(["skill-bench", "report", runId!, "--no-open"], false, root)).resolves.toMatchObject({ ok: true });
      expect(providerCalls).toBe(2);
      const refreshed = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));
      expect(refreshed.reportInput.cells.map((cell: { costUsd: number | null }) => cell.costUsd)).toEqual([0.00315, 0.00315]);
      expect(refreshed.reportInput.pricing).toMatchObject({ source: "public-github-copilot-model-pricing", currency: "USD" });
      expect(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "sweep_report.html"), "utf8")).toContain("$0.003150");
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("fails closed before provider spawn for missing evaluator, stale skill source, missing estimates, and unsupported profiles", async () => {
    const root = tempCwd();
    const skillDir = writeSkill(root, "dynamic-review");
    const base = providerSpecWithEvaluator(root, "guarded-live", {
      skill: { id: "dynamic-review", path: skillDir, fingerprint: sha256Directory(skillDir) },
      fingerprint: { status: "current", skill: sha256Directory(skillDir), model: "model-fp-live", spec: "spec-fp-live", evaluation: "eval-fp-live", provider: "provider-fp-live" },
    });
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["missing-evaluator", { ...withoutKeys(base, ["evaluation"]), id: "missing-evaluator" }, "frozen evaluator descriptor required"],
      [
        "missing-estimates",
        {
          ...base,
          id: "missing-estimates",
          budgets: withoutKeys(base.budgets as Record<string, unknown>, [
            "estimatedCellUsd",
            "estimatedCellPremiumRequests",
          ]),
        },
        "approved conservative per-cell estimates required",
      ],
      ["unsupported-profile", { ...base, id: "unsupported-profile", executionProfile: "unrestricted" }, "unknown execution profile"],
    ];
    let calls = 0;
    setSkillBenchProviderTransportForTests(async () => {
      calls += 1;
      return { status: "complete", stdout: "found issue", stderr: "", exitCode: 0 };
    });
    try {
      for (const [id, spec, message] of cases) {
        writeApprovedSpec(root, id, spec);
        await expect(run(["skill-bench", "run", id, "--pilot", "--approve-spend"], false, root)).resolves.toMatchObject({
          ok: false,
          message: expect.stringContaining(message),
        });
      }
      writeFileSync(path.join(skillDir, "BODY.txt"), "mutated after freeze\n");
      writeApprovedSpec(root, "stale-skill", { ...base, id: "stale-skill" });
      await expect(run(["skill-bench", "run", "stale-skill", "--pilot", "--approve-spend"], false, root)).resolves.toMatchObject({
        ok: false,
        message: expect.stringContaining("frozen skill fingerprint is stale"),
      });
      expect(calls).toBe(0);
    } finally {
      setSkillBenchProviderTransportForTests(null);
    }
  });

  it("rejects forged frozen booleans without a current append-only approval ledger", async () => {
    const root = tempCwd();
    const spec = syntheticSpec("forged-booleans");
    writeJson(root, ".omp/skill-bench/specs/forged-booleans/manifest.json", spec);
    rmSync(path.join(root, ".omp/skill-bench/specs/forged-booleans/approvals.jsonl"));

    await expect(run(["skill-bench", "run", "forged-booleans", "--pilot"], false, root)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("approval ledger required"),
    });
  });


  it("rejects symlinked draft, spec, and run artifact ids before parsing", async () => {
    const root = tempCwd();
    const outside = tempCwd();

    writeJson(outside, "draft-link/design.json", { ...approvedSpec("draft-link"), phase: "design", mode: "guided" });
    mkdirSync(path.join(root, ".omp/skill-bench/drafts"), { recursive: true });
    try {
      symlinkSync(path.join(outside, "draft-link"), path.join(root, ".omp/skill-bench/drafts/draft-link"), "dir");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/^(EPERM|EACCES|ENOTSUP)$/);
      return;
    }
    await expect(run(["skill-bench", "resume", "draft-link"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("symlink"),
    });

    writeJson(outside, "spec-link/manifest.json", syntheticSpec("spec-link"));
    mkdirSync(path.join(root, ".omp/skill-bench/specs"), { recursive: true });
    symlinkSync(path.join(outside, "spec-link"), path.join(root, ".omp/skill-bench/specs/spec-link"), "dir");
    await expect(run(["skill-bench", "run", "spec-link", "--pilot"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("symlink"),
    });

    writeCompletedRunWithEvidence(outside, "run-link");
    const outsideRunDir = path.join(outside, ".omp/skill-bench/runs/run-link");
    writeFileSync(path.join(outsideRunDir, "sweep_report.html"), "<html>outside report</html>\n");
    mkdirSync(path.join(root, ".omp/skill-bench/runs"), { recursive: true });
    symlinkSync(outsideRunDir, path.join(root, ".omp/skill-bench/runs/run-link"), "dir");
    await expect(run(["skill-bench", "report", "run-link", "--no-open"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("symlink"),
    });
  });

  it("rejects symlinked artifact files before parsing", async () => {
    const root = tempCwd();
    const outside = tempCwd();

    writeJson(outside, "design.json", { ...approvedSpec("draft-file-link"), phase: "design", mode: "guided" });
    mkdirSync(path.join(root, ".omp/skill-bench/drafts/draft-file-link"), { recursive: true });
    try {
      symlinkSync(path.join(outside, "design.json"), path.join(root, ".omp/skill-bench/drafts/draft-file-link/design.json"));
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/^(EPERM|EACCES|ENOTSUP)$/);
      return;
    }

    await expect(run(["skill-bench", "resume", "draft-file-link"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("symlink"),
    });
  });


  it("refuses to execute approved-looking draft artifacts", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/drafts/draft-approved/design.json", {
      ...syntheticSpec("draft-approved"),
      phase: "design",
      mode: "guided",
    });

    await expect(run(["skill-bench", "run", "draft-approved", "--pilot"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("draft draft-approved must be resumed and frozen/exported before execution"),
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/runs"))).toBe(false);
  });

  it("allows report and rerun for verified pilot/inconclusive runs without recommendations but rejects apply", async () => {
    const root = tempCwd();
    const id = "pilot-no-recommendation";
    writeJson(root, `.omp/skill-bench/runs/${id}/run.json`, {
      ...completedRun(id),
      mode: "pilot",
      recommendation: undefined,
      fingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
    });
    writeFileSync(path.join(root, `.omp/skill-bench/runs/${id}/sweep_report.html`), "<html>pilot report</html>\n");

    await expect(run(["skill-bench", "report", id, "--no-open"], false, root)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(`.omp/skill-bench/runs/${id}/sweep_report.html`),
    });
    expect(existsSync(path.join(root, `.omp/skill-bench/runs/${id}/sweep_report.html`))).toBe(true);

    const rerunResult = await run(["skill-bench", "rerun", id], false, root);
    expect(rerunResult).toMatchObject({ ok: true, message: expect.stringContaining("rerun prepared") });

    await expect(run(["skill-bench", "apply", id], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("recommendation is not valid"),
    });
  });

  it("gates rerun plans on reproducible current fingerprints", async () => {
    const root = tempCwd();
    writeCompletedRunWithEvidence(root, "run-ready");
    writeCompletedRunWithEvidence(root, "run-stale");
    writeCompletedRunWithEvidence(root, "run-missing");
    writeJson(root, ".omp/skill-bench/runs/run-current-only/run.json", {
      ...completedRun("run-current-only"),
      recommendation: undefined,
      reportInput: undefined,
      fingerprints: undefined,
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
    });
    writeJson(root, ".omp/skill-bench/runs/run-stale/run.json", {
      ...completedRun("run-stale"),
      currentFingerprints: { skill: "skill-fp", model: "different-model-fp", spec: "spec-fp", evaluation: "eval-fp", provider: "provider-fp" },
    });
    writeJson(root, ".omp/skill-bench/runs/run-missing/run.json", {
      ...completedRun("run-missing"),
      currentFingerprints: { skill: "skill-fp", model: "model-fp", spec: "spec-fp", evaluation: "eval-fp" },
    });

    const ready = await run(["skill-bench", "rerun", "run-ready"], false, root);
    expect(ready).toMatchObject({ ok: true, message: expect.stringContaining("fingerprint check ready") });
    const readyPlanPath = /plan: (\S+)/.exec(ready.message ?? "")?.[1];
    expect(JSON.parse(readFileSync(path.join(root, readyPlanPath!), "utf8"))).toMatchObject({
      status: "ready",
      fingerprintGate: { status: "ready", stale: [], missing: [] },
      next: { command: "omp skill-bench run spec-ok --pilot" },
    });

    const stale = await run(["skill-bench", "rerun", "run-stale"], false, root);
    expect(stale).toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("rerun blocked") });
    expect(stale.message).toContain("stale model");
    const stalePlanPath = /plan: (\S+)/.exec(stale.message ?? "")?.[1];
    const stalePlan = JSON.parse(readFileSync(path.join(root, stalePlanPath!), "utf8"));
    expect(stalePlan).toMatchObject({ status: "blocked", fingerprintGate: { status: "blocked" } });
    expect(stalePlan.next.command).toBeUndefined();

    const missing = await run(["skill-bench", "rerun", "run-missing"], false, root);
    expect(missing).toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("missing current.provider") });
    const missingPlanPath = /plan: (\S+)/.exec(missing.message ?? "")?.[1];
    const missingPlan = JSON.parse(readFileSync(path.join(root, missingPlanPath!), "utf8"));
    expect(missingPlan).toMatchObject({ status: "blocked", fingerprintGate: { missing: ["current.provider"] } });
    expect(missingPlan.next.command).toBeUndefined();

    const currentOnly = await run(["skill-bench", "rerun", "run-current-only"], false, root);
    expect(currentOnly).toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("rerun blocked") });
    expect(currentOnly.message).toContain("missing frozen.skill, frozen.model, frozen.spec, frozen.evaluation, frozen.provider");
    const currentOnlyPlanPath = /plan: (\S+)/.exec(currentOnly.message ?? "")?.[1];
    const currentOnlyPlan = JSON.parse(readFileSync(path.join(root, currentOnlyPlanPath!), "utf8"));
    expect(currentOnlyPlan).toMatchObject({
      status: "blocked",
      fingerprintGate: {
        status: "blocked",
        missing: ["frozen.skill", "frozen.model", "frozen.spec", "frozen.evaluation", "frozen.provider"],
      },
      next: { blockedReason: expect.stringContaining("missing frozen.skill") },
    });
    expect(currentOnlyPlan.next.command).toBeUndefined();
  });

  it("does not let crafted artifact content enable synthetic execution outside the internal test gate", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/specs/spec-crafted-synth/manifest.json", syntheticSpec("spec-crafted-synth"));
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await run(["skill-bench", "run", "spec-crafted-synth", "--validated"], false, root);
      expect(result).toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("live provider execution requires explicit approval") });
      expect(result.message).not.toContain("validated synthetic run completed");
      expect(existsSync(path.join(root, ".omp/skill-bench/runs"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("fails closed when synthetic specs omit explicit deterministic cell evidence", async () => {
    const root = tempCwd();
    const spec = syntheticSpec("spec-no-cell-evidence");
    delete (spec as Record<string, unknown>).deterministicEvaluatorResults;
    writeJson(root, ".omp/skill-bench/specs/spec-no-cell-evidence/manifest.json", spec);

    await expect(run(["skill-bench", "run", "spec-no-cell-evidence", "--validated"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("requires explicit deterministicEvaluatorResults or cellResults evidence"),
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/runs"))).toBe(false);
  });

  it("writes complete required evidence bundles for every synthetic cell", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/specs/spec-evidence/manifest.json", syntheticSpec("spec-evidence"));

    const result = await run(["skill-bench", "run", "spec-evidence", "--pilot"], false, root);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("pilot synthetic run completed") });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    expect(runId).toBeTruthy();
    const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));
    expect(runArtifact.evidence).toMatchObject({ status: "verified" });

    for (const proof of runArtifact.reportView.proofMatrices as Array<{ cellId: string }>) {
      const cellRoot = path.join(root, ".omp/skill-bench/runs", runId!, "cells", proof.cellId);
      for (const artifact of REQUIRED_EVIDENCE_ARTIFACTS) {
        expect(existsSync(path.join(cellRoot, artifact)), `${proof.cellId} missing ${artifact}`).toBe(true);
      }
      expect(readFileSync(path.join(cellRoot, "COMPLETE"), "utf8")).toBe("complete\n");
    }
  });

  it("does not emit a valid recommendation when synthetic confidence metadata is invalid", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/specs/spec-insufficient/manifest.json", insufficientSyntheticSpec("spec-insufficient"));

    const result = await run(["skill-bench", "run", "spec-insufficient", "--validated"], false, root);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("validated synthetic run completed") });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));

    expect(runArtifact.reportView.decision.validated).toBe(false);
    expect(runArtifact.reportView.decision.noWinnerReason).toContain("confidence metadata invalid");
    expect(runArtifact.reportView.actions.canApply).toBe(false);
    expect(runArtifact.recommendation?.validated).not.toBe(true);
    expect(existsSync(path.join(root, ".omp/skill-bench/runs", runId!, "recommendation.json"))).toBe(false);
    await expect(run(["skill-bench", "apply", runId!], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("recommendation is not valid"),
    });
  });

  it("validates normal synthetic runs only when CR2 confidence metadata is valid", async () => {
    const root = tempCwd();
    const spec = syntheticSpec("spec-valid-cr2");
    spec.deterministicEvaluatorResults = spec.deterministicEvaluatorResults.map((cell) =>
      cell.modelId === "model-a" && cell.arm === "skill"
        ? { ...cell, qualityScore: 0.8 }
        : cell,
    );
    writeJson(root, ".omp/skill-bench/specs/spec-valid-cr2/manifest.json", spec);

    const result = await run(["skill-bench", "run", "spec-valid-cr2", "--validated"], false, root);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("validated synthetic run completed") });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));

    expect(runArtifact.reportView.decision.validated).toBe(true);
    expect(runArtifact.reportView.decision.confidence).toMatchObject({
      familywiseAlpha: 0.05,
      comparisonCount: 1,
      frozenPairIds: ["baseline__skill"],
      resamples: 10_000,
      sampleCount: 6,
      verdict: "winner",
    });
    expect(runArtifact.recommendation).toMatchObject({
      validated: true,
      selectedModel: { id: "model-b" },
      confidence: { verdict: "winner", samples: 6 },
    });
    expect(runArtifact.routingCapabilities).toEqual([
      expect.objectContaining({
        surface: "copilot-interactive",
        capability: "advisory",
        verified: false,
      }),
    ]);
    expect(runArtifact.reportView.decision.recommendedRoute).toEqual({
      skillId: "dynamic-review",
      modelId: "model-b",
      objective: "quality-first",
    });
    await expect(
      run(["skill-bench", "apply", runId!], false, root),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("capability=advisory"),
    });
    expect(
      readFileSync(path.join(root, ".github", "copilot-instructions.md"), "utf8"),
    ).toContain("Recommended model: model-b");
    const sourceManifestPath = path.join(
      root,
      ".omp",
      "skill-bench",
      "specs",
      "spec-valid-cr2",
      "manifest.json",
    );
    const changedSource = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    writeFileSync(
      sourceManifestPath,
      `${JSON.stringify({ ...changedSource, routingObjective: "cost-min" }, null, 2)}\n`,
    );
    await expect(
      run(["skill-bench", "apply", runId!, "--dry-run"], false, root),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("stale fingerprint: spec"),
    });
    expect(
      readFileSync(path.join(root, ".github", "copilot-instructions.md"), "utf8"),
    ).toContain(`omp skill-bench apply ${runId} --dry-run`);
  });

  it("excludes quality-failing skill cells from routing candidates", async () => {
    const root = tempCwd();
    const spec = { ...syntheticSpec("spec-quality-gated-route"), routingObjective: "cost-min" };
    spec.deterministicEvaluatorResults = spec.deterministicEvaluatorResults.map((cell) => {
      if (cell.arm !== "skill") return cell;
      if (cell.modelId === "model-a")
        return { ...cell, qualityScore: cell.scenarioId === "regression" ? 0 : 1 };
      return { ...cell, qualityScore: 0.6 };
    });
    writeJson(root, ".omp/skill-bench/specs/spec-quality-gated-route/manifest.json", spec);

    const result = await run(["skill-bench", "run", "spec-quality-gated-route", "--validated"], false, root);
    expect(result).toMatchObject({ ok: true });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));

    expect(runArtifact.reportView.decision.validated).toBe(true);
    expect(runArtifact.reportView.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "model-a", arm: "skill", qualityPassed: false }),
    ]));
    expect(runArtifact.recommendation).toMatchObject({
      validated: true,
      selectedModel: { id: "model-b" },
    });
  });

  it("requires a recommended model to quality-pass every approved scenario", async () => {
    const root = tempCwd();
    const spec = syntheticSpec("spec-route-full-coverage");
    spec.deterministicEvaluatorResults = spec.deterministicEvaluatorResults.map((cell) =>
      cell.arm === "skill" && cell.scenarioId === "regression"
        ? { ...cell, qualityScore: 0 }
        : cell,
    );
    writeJson(root, ".omp/skill-bench/specs/spec-route-full-coverage/manifest.json", spec);

    const result = await run(["skill-bench", "run", "spec-route-full-coverage", "--validated"], false, root);
    expect(result).toMatchObject({ ok: true });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    const runArtifact = JSON.parse(readFileSync(path.join(root, ".omp/skill-bench/runs", runId!, "run.json"), "utf8"));

    expect(runArtifact.reportView.decision.validated).toBe(true);
    expect(runArtifact.reportView.decision.taskChoices).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "regression", state: "fail" }),
    ]));
    expect(runArtifact.reportView.decision.recommendedRoute).toBeNull();
    expect(runArtifact.recommendation).toBeUndefined();
  });

  it("fails closed for missing report artifacts and unverified non-dry-run apply", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/runs/run-no-report/run.json", completedRun("run-no-report"));
    writeJson(root, ".omp/skill-bench/runs/run-unverified/run.json", { ...completedRun("run-unverified"), routingCapabilities: [] });
    writeJson(root, ".omp/skill-bench/runs/run-json-only/run.json", completedRun("run-json-only"));

    await expect(run(["skill-bench", "report", "run-no-report", "--no-open"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "No report artifact exists for skill-bench run run-no-report; expected .omp/skill-bench/runs/run-no-report/sweep_report.html." });
    await expect(run(["skill-bench", "apply", "run-unverified"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench apply disabled for run-unverified: missing verified OMP effective route evidence or Copilot advisory capability." });
    await expect(run(["skill-bench", "apply", "run-unverified", "--dry-run"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("verified=false") });
    await expect(run(["skill-bench", "apply", "run-json-only"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench apply disabled for run-json-only: missing verified OMP effective route evidence or Copilot advisory capability." });
    await expect(run(["skill-bench", "apply", "run-json-only", "--dry-run"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("verified=false") });
  });

  it("applies Copilot recommendations as marker-bounded advisory instructions without claiming enforcement", async () => {
    const root = tempCwd();
    const existing = "# Existing project instructions\n\nKeep this content.\n";
    writeJson(root, ".omp/skill-bench/runs/run-advisory/run.json", {
      ...completedRun("run-advisory"),
      routingCapabilities: [
        {
          surface: "copilot-interactive",
          capability: "advisory",
          reason: "Copilot interactive v1 cannot be enforced after session start",
          desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
          effectiveRoute: null,
          verified: false,
          verificationEvidence: null,
        },
      ],
    });
    const instructions = path.join(root, ".github", "copilot-instructions.md");
    mkdirSync(path.dirname(instructions), { recursive: true });
    writeFileSync(instructions, existing);

    await expect(
      run(["skill-bench", "apply", "run-advisory"], false, root),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("capability=advisory"),
    });
    const first = readFileSync(instructions, "utf8");
    expect(first).toContain(existing.trim());
    expect(first).toContain("Recommended skill: code-review");
    expect(first).toContain("Recommended model: gpt-test");
    expect(first.match(/BEGIN OMP SKILL-BENCH ROUTE/g)).toHaveLength(1);

    await expect(
      run(["skill-bench", "apply", "run-advisory"], false, root),
    ).resolves.toMatchObject({ ok: true });
    expect(readFileSync(instructions, "utf8")).toBe(first);
  });

  it("detects conflicts from current managed routing state and Copilot instruction markers", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/runs/run-route-a/run.json", {
      ...completedRun("run-route-a"),
      recommendation: routingRecommendation("run-route-a"),
      routingCapabilities: [
        {
          surface: "copilot-interactive",
          capability: "advisory",
          reason: "Copilot interactive v1 cannot be enforced after session start",
          desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
          effectiveRoute: null,
          verified: false,
          verificationEvidence: null,
        },
      ],
    });
    const conflictingRecommendation = {
      ...routingRecommendation("run-route-b"),
      selectedModel: { id: "gpt-other", fingerprint: "model-fp" },
    };
    writeJson(root, ".omp/skill-bench/runs/run-route-b/run.json", {
      ...completedRun("run-route-b"),
      recommendation: conflictingRecommendation,
      routingCapabilities: [
        {
          surface: "copilot-interactive",
          capability: "advisory",
          reason: "Copilot interactive v1 cannot be enforced after session start",
          desiredRoute: { skillId: "code-review", modelId: "gpt-other" },
          effectiveRoute: null,
          verified: false,
          verificationEvidence: null,
        },
      ],
    });

    await expect(
      run(["skill-bench", "apply", "run-route-a"], false, root),
    ).resolves.toMatchObject({ ok: true });
    const routingState = path.join(root, ".omp", "skill-bench", "routing.json");
    const instructions = path.join(root, ".github", "copilot-instructions.md");
    expect(JSON.parse(readFileSync(routingState, "utf8"))).toMatchObject({
      schemaVersion: 1,
      rules: [
        expect.objectContaining({
          scope: "project",
          taskMatcher: "code-review",
          skillId: "code-review",
          modelId: "gpt-test",
          recommendationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          instructionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      integrity: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });

    const dryRun = await run(
      ["skill-bench", "apply", "run-route-b", "--dry-run"],
      false,
      root,
    );
    expect(dryRun).toMatchObject({
      ok: true,
      message: expect.stringContaining("disabled=conflicting route already exists"),
    });
    expect(dryRun.message).toContain("existing project code-review -> code-review@gpt-test");
    const firstInstructions = readFileSync(instructions, "utf8");
    await expect(
      run(["skill-bench", "apply", "run-route-b"], false, root),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("conflicting route already exists"),
    });
    expect(readFileSync(instructions, "utf8")).toBe(firstInstructions);

    rmSync(routingState);
    await expect(
      run(["skill-bench", "apply", "run-route-b", "--dry-run"], false, root),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("conflicting route already exists"),
    });
  });

  it("previews advisory apply without writing and fails closed on corrupt instruction markers", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/runs/run-advisory-preview/run.json", {
      ...completedRun("run-advisory-preview"),
      routingCapabilities: [
        {
          surface: "copilot-interactive",
          capability: "advisory",
          reason: "Copilot interactive v1 cannot be enforced after session start",
          desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
          effectiveRoute: null,
          verified: false,
          verificationEvidence: null,
        },
      ],
    });
    const instructions = path.join(root, ".github", "copilot-instructions.md");

    await expect(
      run(
        ["skill-bench", "apply", "run-advisory-preview", "--dry-run"],
        false,
        root,
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("capability=advisory"),
    });
    expect(existsSync(instructions)).toBe(false);

    mkdirSync(path.dirname(instructions), { recursive: true });
    writeFileSync(
      instructions,
      "<!-- BEGIN OMP SKILL-BENCH ROUTE -->\ntruncated\n",
    );
    await expect(
      run(["skill-bench", "apply", "run-advisory-preview"], false, root),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringMatching(/marker/i),
    });
    expect(readFileSync(instructions, "utf8")).toBe(
      "<!-- BEGIN OMP SKILL-BENCH ROUTE -->\ntruncated\n",
    );
  });

  it("writes global advisory routing to COPILOT_HOME when user scope is approved", async () => {
    const root = tempCwd();
    const copilotHome = path.join(tempCwd(), "copilot-home");
    const recommendation = {
      ...routingRecommendation("run-global-advisory"),
      scope: "global",
    };
    writeJson(root, ".omp/skill-bench/runs/run-global-advisory/run.json", {
      ...completedRun("run-global-advisory"),
      recommendation,
      routingCapabilities: [
        {
          surface: "copilot-interactive",
          capability: "advisory",
          reason: "Copilot interactive v1 cannot be enforced after session start",
          desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
          effectiveRoute: null,
          verified: false,
          verificationEvidence: null,
        },
      ],
    });
    const previous = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = copilotHome;
    try {
      await expect(
        run(["skill-bench", "apply", "run-global-advisory"], false, root),
      ).resolves.toMatchObject({
        ok: true,
        message: expect.stringContaining("capability=advisory"),
      });
    } finally {
      if (previous === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = previous;
    }
    expect(
      readFileSync(path.join(copilotHome, "copilot-instructions.md"), "utf8"),
    ).toContain("Recommended skill: code-review");
  });

  it("fails closed for unsafe export manifest content and symlinks", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/runs/run-secret/run.json", { ...completedRun("run-secret"), exportManifest: { files: [".omp/skill-bench/runs/run-secret/unsafe.txt"] } });
    writeFileSync(path.join(root, ".omp/skill-bench/runs/run-secret/unsafe.txt"), "RAW_PROMPT_SENTINEL /Users/alice/private sk-abcdefghi\n");
    await expect(run(["skill-bench", "export", "run-secret", "--output", "secret.json"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("Privacy preflight failed") });
    expect(existsSync(path.join(root, "secret.json"))).toBe(false);

    writeJson(root, ".omp/skill-bench/runs/run-link/run.json", { ...completedRun("run-link"), exportManifest: { files: [".omp/skill-bench/runs/run-link/link.txt"] } });
    symlinkSync(path.join(root, ".omp/skill-bench/runs/run-secret/unsafe.txt"), path.join(root, ".omp/skill-bench/runs/run-link/link.txt"));
    await expect(run(["skill-bench", "export", "run-link", "--output", "link.json"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("unresolved symlink") });
    expect(existsSync(path.join(root, "link.json"))).toBe(false);

    writeJson(root, ".omp/skill-bench/runs/run-absolute-export/run.json", { ...completedRun("run-absolute-export"), exportManifest: { files: [path.join(root, ".omp/skill-bench/runs/run-secret/unsafe.txt")] } });
    await expect(run(["skill-bench", "export", "run-absolute-export", "--output", "absolute.json"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("absolute private path") });
    expect(existsSync(path.join(root, "absolute.json"))).toBe(false);

    writeJson(root, ".omp/skill-bench/runs/run-traversal-export/run.json", { ...completedRun("run-traversal-export"), exportManifest: { files: [".omp/skill-bench/runs/run-traversal-export/../run-secret/unsafe.txt"] } });
    await expect(run(["skill-bench", "export", "run-traversal-export", "--output", "traversal.json"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("unsafe relative path") });
    expect(existsSync(path.join(root, "traversal.json"))).toBe(false);
  });

  it("round-trips a portable frozen spec bundle into an unapproved draft and rejects tampering", async () => {
    const source = tempCwd();
    const target = tempCwd();
    const specId = "portable-spec";
    const specRoot = path.join(source, ".omp", "skill-bench", "specs", specId);
    const bundledSkill = path.join(specRoot, "bundle", "skill");
    const bundledEvaluator = path.join(specRoot, "bundle", "evaluator.mjs");
    mkdirSync(bundledSkill, { recursive: true });
    writeFileSync(
      path.join(bundledSkill, "SKILL.md"),
      "---\nname: portable-review\ndescription: Portable review skill.\n---\n",
    );
    writeFileSync(
      bundledEvaluator,
      "process.stdout.write(JSON.stringify({schemaVersion:1,label:'answer-quality',score:1,proofMatrix:{expected:[],found:[],done:[],missed:[],falsePositive:[],incorrect:[],proof:[]},evidence:[]}));\n",
    );
    const manifest = {
      ...approvedSpec(specId),
      provider: { kind: "copilot", approved: true },
      execution: { allowlistedTools: ["view"] },
      budgets: {
        ...approvedSpec(specId).budgets,
        estimatedCellUsd: 0.01,
        estimatedCellPremiumRequests: 1,
      },
      skill: {
        id: "portable-review",
        path: "bundle/skill",
        fingerprint: sha256Directory(bundledSkill),
      },
      evaluation: {
        schemaVersion: 1,
        command: ["node", "bundle/evaluator.mjs"],
        evaluator: {
          schemaVersion: 1,
          path: "bundle/evaluator.mjs",
          sha256: sha256File(bundledEvaluator),
          provenance: "approved-portable-test",
          approvedRoot: "bundle",
        },
      },
      exportManifest: {
        files: [
          `.omp/skill-bench/specs/${specId}/manifest.json`,
          `.omp/skill-bench/specs/${specId}/approvals.jsonl`,
          `.omp/skill-bench/specs/${specId}/bundle/skill/SKILL.md`,
          `.omp/skill-bench/specs/${specId}/bundle/evaluator.mjs`,
        ],
      },
    };
    writeJson(
      source,
      `.omp/skill-bench/specs/${specId}/manifest.json`,
      manifest,
    );
    await expect(
      approvePortableExport(specId, "portable.json", false, source),
    ).resolves.toMatchObject({ ok: true });

    writeSkill(target, "seed-skill");
    const design = await run(
      ["skill-bench", "seed-skill", "--model", "model-a"],
      false,
      target,
    );
    const draftId = /draft-id=(\S+)/.exec(design.message ?? "")?.[1];
    expect(draftId).toBeTruthy();
    const portable = readFileSync(path.join(source, "portable.json"));
    writeFileSync(path.join(target, "portable.json"), portable);
    await expect(
      run(
        ["skill-bench", "resume", draftId!, "--import", "portable.json"],
        false,
        target,
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("imported reviewed manifest"),
    });
    await expect(
      run(["skill-bench", "resume", draftId!, "--freeze"], false, target),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("missing current gates"),
    });

    const tampered = JSON.parse(portable.toString("utf8"));
    tampered.files[0].content = `${tampered.files[0].content}A`;
    writeFileSync(path.join(target, "tampered.json"), JSON.stringify(tampered));
    const secondDesign = await run(
      ["skill-bench", "seed-skill", "--model", "model-b"],
      false,
      target,
    );
    const secondDraftId = /draft-id=(\S+)/.exec(secondDesign.message ?? "")?.[1];
    await expect(
      run(
        [
          "skill-bench",
          "resume",
          secondDraftId!,
          "--import",
          "tampered.json",
        ],
        false,
        target,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/integrity|sha256/i),
    });
  });

  it("resolves stored report rerun and export artifact paths from the project skill-bench root when invoked from a nested cwd", async () => {
    const root = tempCwd();
    const nested = path.join(root, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(root, "package.json"), "{\"name\":\"rooted-skill-bench-test\"}\n");
    writeCompletedRunWithEvidence(root, "run-nested");
    writeFileSync(path.join(root, ".omp/skill-bench/runs/run-nested/sweep_report.html"), "<html>root report</html>\n");

    await expect(run(["skill-bench", "report", "run-nested", "--no-open"], false, nested)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("../.omp/skill-bench/runs/run-nested/sweep_report.html") });
    const rerunResult = await run(["skill-bench", "rerun", "run-nested"], false, nested);
    expect(rerunResult).toMatchObject({ ok: true, message: expect.stringContaining("rerun prepared") });
    const rerunPlanPath = /plan: (\S+)/.exec(rerunResult.message ?? "")?.[1];
    expect(rerunPlanPath).toBeTruthy();
    expect(existsSync(path.resolve(nested, rerunPlanPath!))).toBe(true);

    await expect(approvePortableExport("run-nested", "bundle.json", false, nested)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("bundle.json") });
    expect(JSON.parse(readFileSync(path.join(nested, "bundle.json"), "utf8"))).toMatchObject({ phase: "export", id: "run-nested", includedFiles: [".omp/skill-bench/runs/run-nested/run.json"] });
  });

  it("resolves global scope report evidence and export paths from the user skill-bench root", async () => {
    const root = tempCwd();
    const home = tempCwd();
    const id = "run-global";
    const recommendation = { ...routingRecommendation(id), scope: "global" };
    const evidence = {
      schemaVersion: 1,
      runId: id,
      recommendationSha256: sha256Json(recommendation),
      desiredRoute: { skillId: "code-review", modelId: "gpt-test" },
      effectiveRoute: { skillId: "code-review", modelId: "gpt-test" },
    };
    const evidenceContent = `${JSON.stringify(evidence, null, 2)}\n`;
    writeJson(home, `.omp/skill-bench/runs/${id}/run.json`, {
      ...completedRun(id, "spec-global", sha256Text(evidenceContent)),
      recommendation,
      reportPath: `.omp/skill-bench/runs/${id}/sweep_report.html`,
      exportManifest: { files: [`.omp/skill-bench/runs/${id}/run.json`] },
    });
    writeFileSync(path.join(home, `.omp/skill-bench/runs/${id}/route-evidence.json`), evidenceContent);
    writeFileSync(path.join(home, `.omp/skill-bench/runs/${id}/sweep_report.html`), "<html>global report</html>\n");

    await withHome(home, async () => {
      await expect(run(["skill-bench", "report", id, "--no-open"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining(`.omp/skill-bench/runs/${id}/sweep_report.html`) });
      await expect(run(["skill-bench", "apply", id], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("verified=true") });
      await expect(approvePortableExport(id, "global-bundle.json", false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("global-bundle.json") });
    });
    expect(JSON.parse(readFileSync(path.join(root, "global-bundle.json"), "utf8"))).toMatchObject({ phase: "export", id, includedFiles: [`.omp/skill-bench/runs/${id}/run.json`] });
  });

  it("regenerates reports only at the canonical run report path", async () => {
    const root = tempCwd();
    const outsidePath = path.join(root, "outside-report.html");
    writeJson(root, ".omp/skill-bench/runs/run-absolute-report/run.json", {
      ...completedRun("run-absolute-report"),
      reportPath: outsidePath,
      reportInput: {
        schemaVersion: 1,
        runId: "run-absolute-report",
        mode: "pilot",
        status: "completed",
        spec: { id: "spec", fingerprint: "spec-fp", evaluationFingerprint: "eval-fp", seed: "seed", rerunCommand: "omp skill-bench rerun run-absolute-report" },
        skill: { id: "skill", fingerprint: "skill-fp" },
        model: { id: "model", fingerprint: "model-fp" },
        environment: { provider: "synthetic", fingerprint: "provider-fp" },
        pricing: { source: "synthetic", completeness: "complete" },
        budget: {},
        warnings: [],
        cells: [],
      },
    });

    await expect(run(["skill-bench", "report", "run-absolute-report", "--no-open"], false, root)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(".omp/skill-bench/runs/run-absolute-report/sweep_report.html"),
    });
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(path.join(root, ".omp/skill-bench/runs/run-absolute-report/sweep_report.html"))).toBe(true);
  });

  it("supports path target runs and no-id resume of the latest durable draft", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/drafts/older/design.json", { ...approvedSpec("older"), phase: "design" });
    const olderPath = path.join(root, ".omp/skill-bench/drafts/older/design.json");
    writeJson(root, ".omp/skill-bench/drafts/newer/design.json", { ...approvedSpec("newer"), phase: "design" });
    const newerPath = path.join(root, ".omp/skill-bench/drafts/newer/design.json");
    const now = new Date();
    const old = new Date(now.getTime() - 10_000);
    utimesSync(olderPath, old, old);
    utimesSync(newerPath, now, now);
    await expect(run(["skill-bench", "resume"], false, root)).resolves.toMatchObject({ ok: true, message: expect.stringContaining("Resumed skill-bench draft newer") });

    writeJson(root, "bench-specs/path-spec-manifest.json", syntheticSpec("path-spec"));
    const specPath = path.join(root, "bench-specs/path-spec-manifest.json");
    appendAdjacentApprovalLedger(specPath, syntheticSpec("path-spec"));
    const result = await run(["skill-bench", "run", specPath, "--pilot"], false, root);
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining("pilot synthetic run completed for path-spec") });
    const runId = /run-id=(\S+)/.exec(result.message ?? "")?.[1];
    expect(existsSync(path.join(root, ".omp/skill-bench/runs", runId!, "cells", "normal-model-a-skill", "scorer.json"))).toBe(true);

    writeJson(root, ".omp/skill-bench/runs/prior-run/run.json", syntheticSpec("prior-run"));
    await expect(run(["skill-bench", "run", ".omp/skill-bench/runs/prior-run/run.json", "--pilot"], false, root)).resolves.toMatchObject({
      ok: false,
      exitCode: 1,
      message: expect.stringContaining("expected a manifest/spec JSON artifact"),
    });
    expect(existsSync(path.join(root, ".omp/skill-bench/runs/prior-run/reruns"))).toBe(false);
    expect(readdirSync(path.join(root, ".omp/skill-bench/runs")).filter((name) => name !== "prior-run")).toEqual([runId!]);

    for (const blockedPath of [
      ".omp/skill-bench/runs/prior-run/summary.json",
      ".omp/skill-bench/runs/prior-run/recommendation.json",
      ".omp/skill-bench/preflights/preflight-1/preflight.json",
      ".omp/skill-bench/drafts/draft-1/design.json",
      "bench-specs/../bench-specs/path-spec-manifest.json",
    ]) {
      writeJson(root, blockedPath, syntheticSpec("blocked-spec"));
      await expect(run(["skill-bench", "run", blockedPath, "--pilot"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1 });
    }

    const outside = tempCwd();
    writeJson(outside, "manifest.json", syntheticSpec("outside-spec"));
    await expect(run(["skill-bench", "run", path.join(outside, "manifest.json"), "--pilot"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("Unsafe skill-bench artifact path") });
  });

  it("rejects strict traversal artifact ids and disables apply when current fingerprints are missing", async () => {
    const root = tempCwd();
    writeCompletedRunWithEvidence(root, "run-ok");
    writeJson(root, ".omp/skill-bench/runs/run-missing-current/run.json", { ...completedRun("run-missing-current"), currentFingerprints: {} });

    for (const badId of [".", "..", ".hidden", "../run-ok"]) {
      await expect(run(["skill-bench", "report", badId, "--no-open"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("Missing verified skill-bench run") });
    }
    await expect(run(["skill-bench", "resume", ".hidden"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing persisted skill-bench draft: .hidden." });
    await expect(run(["skill-bench", "apply", "run-missing-current"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench apply disabled for run-missing-current: missing current fingerprints; routing is stale/unverified." });
  });

  it("fails closed for arbitrary missing run report and non-dry-run apply ids", async () => {
    const root = tempCwd();

    await expect(run(["skill-bench", "run", "missing-spec", "--pilot"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing approved skill-bench draft/spec: missing-spec." });
    await expect(run(["skill-bench", "resume"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing persisted skill-bench draft: no durable drafts found." });
    await expect(run(["skill-bench", "resume", "missing-draft"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing persisted skill-bench draft: missing-draft." });
    await expect(run(["skill-bench", "report", "missing-run", "--no-open"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing verified skill-bench run: missing-run." });
    await expect(run(["skill-bench", "apply", "missing-run"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing verified skill-bench run: missing-run." });
    await expect(run(["skill-bench", "apply", "missing-run", "--dry-run"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing verified skill-bench run: missing-run." });
    await expect(run(["skill-bench", "rerun", "missing-run"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing verified skill-bench run: missing-run." });
    await expect(run(["skill-bench", "export", "missing-run", "--output", "bundle.tgz"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing exportable skill-bench spec/run: missing-run." });
  });

  it("fails closed when approvals recommendations evidence fingerprints or conflicts are unsafe", async () => {
    const root = tempCwd();
    writeJson(root, ".omp/skill-bench/specs/no-budget/manifest.json", { ...approvedSpec("no-budget"), approvals: { frozen: true, budget: false, liveCellsAllowed: false } });
    writeJson(root, ".omp/skill-bench/specs/bad-recommendation/manifest.json", { ...approvedSpec("bad-recommendation"), scenarios: [], recommendation: { valid: false, selected: "code-review" } });
    writeJson(root, ".omp/skill-bench/runs/stale-run/run.json", { ...completedRun("stale-run"), fingerprint: { status: "stale" } });
    writeJson(root, ".omp/skill-bench/runs/conflict-run/run.json", { ...completedRun("conflict-run"), conflicts: { status: "blocked" } });

    await expect(run(["skill-bench", "run", "no-budget", "--pilot"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench artifact no-budget is not approved: budget approval required." });
    await expect(run(["skill-bench", "run", "no-budget", "--validated"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench artifact no-budget is not approved: budget approval required." });
    await expect(run(["skill-bench", "run", "bad-recommendation", "--pilot"], false, root)).resolves.toMatchObject({ ok: false, exitCode: 1, message: expect.stringContaining("missing scenarios") });
    await expect(run(["skill-bench", "report", "stale-run"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench artifact stale-run is not approved: fingerprint is stale." });
    await expect(run(["skill-bench", "apply", "conflict-run"], false, root)).resolves.toEqual({ ok: false, exitCode: 1, message: "Skill-bench artifact conflict-run is not approved: conflicts are not clear." });
  });

  it("rejects invalid conflicts, missing ids, and stray args with exact guidance", async () => {
    await expect(run(["skill-bench", "run", "draft-1", "--pilot", "--validated"])).resolves.toEqual({ ok: false, exitCode: 1, message: "Choose exactly one run mode: --pilot or --validated." });
    await expect(run(["skill-bench", "run", "--pilot"])).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing skill-bench id. Usage: omp skill-bench run <spec-id-or-path> --pilot|--validated [--approve-spend]." });
    await expect(run(["skill-bench", "report", "run-1", "extra"])).resolves.toEqual({ ok: false, exitCode: 1, message: "Unexpected skill-bench argument: extra. See: omp skill-bench --help." });
    await expect(run(["skill-bench", "--project", "team"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--project accepts: current, all." });
    await expect(run(["skill-bench", "--window"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--window requires a value." });
    await expect(run(["skill-bench", "--model", "../unsafe"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--model must be a safe model id." });
    await expect(run(["skill-bench", "--judge-model", "bad id"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--judge-model must be a safe model id." });
    await expect(run(["skill-bench", "--execution-profile", "prod"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--execution-profile accepts: restricted, normal-project, custom." });
    await expect(run(["skill-bench", "--max-usd", "-1"])).resolves.toEqual({ ok: false, exitCode: 1, message: "--max-usd requires a non-negative number." });
    await expect(run(["skill-bench", "export", "run-1"])).resolves.toEqual({ ok: false, exitCode: 1, message: "Missing export output. Usage: omp skill-bench export <spec-id-or-run-id> --output <path> [--approve]." });
  });

  it("emits one JSON value and non-TTY/json cannot bypass approvals", async () => {
    const jsonRoot = tempCwd();
    writeSkill(jsonRoot, "arbitrary-skill");
    const result = await run(["skill-bench", "arbitrary-skill", "--json"], true, jsonRoot);
    expect(result.ok).toBe(true);
    expect(result.message).toBeUndefined();
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      phase: "design",
      id: expect.stringMatching(/^direct-[a-f0-9]{12}$/),
      mode: "direct",
      skillOrPath: "arbitrary-skill",
      approvals: { frozen: false, liveCellsAllowed: false },
      next: { command: expect.stringMatching(/^omp skill-bench resume direct-[a-f0-9]{12}$/) },
    });
    expect(JSON.parse(JSON.stringify(result.output))).toEqual(result.output);
  });

  it("does not leave the unreleased Python harness installed", () => {
    expect(existsSync("benchmarks/skill-bench")).toBe(false);
  });
});
