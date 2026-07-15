import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMatchedExecutionCells,
  buildCandidateRequest,
  classifyCellFailure,
  copilotProviderTransport,
  ensureProviderWorkspace,
  fingerprintSkillDirectory,
  finalizeEvidenceBundle,
  parseCopilotJsonUsage,
  scheduleCellsWithinCeilings,
} from "../../src/skill-bench/execute.js";

const runRoot = () => mkdtempSync(path.join(tmpdir(), "omp-skill-bench-execute-"));

function directoryHash(directory: string): string {
  const hash = createHash("sha256");
  for (const name of ["SKILL.md", "reference.txt"]) {
    hash.update(name).update("\0").update(readFileSync(path.join(directory, name))).update("\0");
  }
  return hash.digest("hex");
}

const basePlan = () => ({
  runId: "run-a",
  scenarioId: "scenario-a",
  task: "Find the regression without reading hidden references.",
  visibleFixtureFingerprint: "fixture-sha256",
  modelId: "gpt-5.5",
  permissions: ["Read", "Edit"],
  timeoutMs: 30_000,
  contextFingerprint: "context-sha256",
  seed: "seed-a",
  workspaceSource: { kind: "template" as const, fingerprint: "workspace-sha256" },
  executionProfile: { kind: "restricted" as const, customInstructions: "must be suppressed", allowlistedTools: ["Read"] },
  selectedSkillId: "history-analyze",
  promptArm: { approved: false, prompt: "use this guidance" },
  runRoot: runRoot(),
  hiddenAssets: {
    referencePath: "/hidden/reference.json",
    evaluatorPath: "/hidden/evaluator.mjs",
    judgePrompt: "secret judge prompt",
  },
});

describe("skill-bench matched execution cells", () => {
  it("creates matched baseline and skill cells where only skill exposure differs", () => {
    const cells = buildMatchedExecutionCells(basePlan());

    expect(cells.map((cell) => cell.arm)).toEqual(["baseline", "skill"]);
    expect(new Set(cells.map((cell) => cell.workspacePath)).size).toBe(2);
    expect(cells[0].workspacePath).not.toBe(cells[1].workspacePath);

    const comparable = cells.map((cell) => {
      const { id, arm, workspacePath, skillExposure, ...rest } = cell;
      void id;
      void arm;
      void workspacePath;
      void skillExposure;
      return rest;
    });
    expect(comparable[0]).toEqual(comparable[1]);
    expect(cells[0].skillExposure).toEqual({ selectedSkillId: null, prompt: null });
    expect(cells[1].skillExposure).toEqual({
      selectedSkillId: "history-analyze",
      sourcePath: undefined,
      fingerprint: undefined,
      requiredTool: "skill",
      prompt: null,
    });
  });

  it("includes prompt arm only when explicitly approved", () => {
    expect(buildMatchedExecutionCells(basePlan()).map((cell) => cell.arm)).toEqual(["baseline", "skill"]);
    const approved = basePlan();
    approved.promptArm.approved = true;
    expect(buildMatchedExecutionCells(approved).map((cell) => cell.arm)).toEqual(["baseline", "skill", "prompt"]);
  });

  it("builds candidate requests without hidden reference or evaluator assets and suppresses custom instructions in restricted profile", () => {
    const [baseline] = buildMatchedExecutionCells(basePlan());
    const request = buildCandidateRequest(baseline);

    expect(JSON.stringify(request)).not.toContain("/hidden/reference.json");
    expect(JSON.stringify(request)).not.toContain("/hidden/evaluator.mjs");
    expect(JSON.stringify(request)).not.toContain("secret judge prompt");
    expect(request.executionProfile).toEqual({ kind: "restricted", customInstructions: null, allowlistedTools: ["Read"] });
  });

  it("stages the exact frozen skill under the project skill root and keeps baseline empty", () => {
    const source = runRoot();
    writeFileSync(path.join(source, "SKILL.md"), "---\nname: dynamic-review\ndescription: test\n---\n");
    writeFileSync(path.join(source, "reference.txt"), "frozen bytes\n");
    const plan = basePlan();
    plan.selectedSkillId = "dynamic-review";
    plan.selectedSkillPath = source;
    plan.selectedSkillFingerprint = directoryHash(source);
    const [baseline, skill] = buildMatchedExecutionCells(plan);

    ensureProviderWorkspace(baseline);
    expect(existsSync(path.join(baseline.workspacePath, ".github", "skills"))).toBe(false);

    ensureProviderWorkspace(skill);
    const staged = path.join(skill.workspacePath, ".github", "skills", "dynamic-review");
    expect(existsSync(path.join(staged, "SKILL.md"))).toBe(true);
    expect(directoryHash(staged)).toBe(plan.selectedSkillFingerprint);

    writeFileSync(path.join(source, "reference.txt"), "mutated after freeze\n");
    const replay = buildMatchedExecutionCells({ ...plan, runRoot: runRoot() })[1];
    expect(() => ensureProviderWorkspace(replay)).toThrow(/fingerprint/i);
  });

  it("prepares each arm from the exact frozen visible fixture without leaking its source path", () => {
    const fixture = runRoot();
    writeFileSync(path.join(fixture, "fixture.txt"), "approved fixture\n");
    const fixtureFingerprint = fingerprintSkillDirectory(fixture);
    const selectedSkill = runRoot();
    writeFileSync(path.join(selectedSkill, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture test\n---\n");
    const base = basePlan();
    const [baseline, skill] = buildMatchedExecutionCells({
      ...base,
      selectedSkillPath: selectedSkill,
      selectedSkillFingerprint: fingerprintSkillDirectory(selectedSkill),
      workspaceSource: {
        kind: "frozen-fixture",
        fingerprint: fixtureFingerprint,
        sourcePath: fixture,
      },
    });

    ensureProviderWorkspace(baseline);
    ensureProviderWorkspace(skill);
    expect(readFileSync(path.join(baseline.workspacePath, "fixture.txt"), "utf8")).toBe("approved fixture\n");
    expect(readFileSync(path.join(skill.workspacePath, "fixture.txt"), "utf8")).toBe("approved fixture\n");
    expect(JSON.stringify(buildCandidateRequest(baseline))).not.toContain(fixture);

    writeFileSync(path.join(baseline.workspacePath, "contamination.txt"), "dirty\n");
    ensureProviderWorkspace(baseline);
    expect(existsSync(path.join(baseline.workspacePath, "contamination.txt"))).toBe(false);
  });

  it("rejects visible fixtures that pre-seed reserved skill or provider-home roots", () => {
    for (const reserved of [path.join(".github", "skills", "hidden", "SKILL.md"), path.join(".omp-copilot-home", "config.json")]) {
      const fixture = runRoot();
      mkdirSync(path.dirname(path.join(fixture, reserved)), { recursive: true });
      writeFileSync(path.join(fixture, reserved), "reserved\n");
      const [baseline] = buildMatchedExecutionCells({
        ...basePlan(),
        workspaceSource: {
          kind: "frozen-fixture",
          fingerprint: fingerprintSkillDirectory(fixture),
          sourcePath: fixture,
        },
      });

      expect(() => ensureProviderWorkspace(baseline)).toThrow(/reserved/i);
    }
  });

  it("extracts direct Copilot JSON usage without zero-filling missing categories", () => {
    const usage = parseCopilotJsonUsage([
      JSON.stringify({ type: "assistant.message", data: { usage: { inputTokens: 10, outputTokens: 4 } } }),
      JSON.stringify({ type: "session.shutdown", data: { usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 5 }, totalNanoAiu: 6_506_145_000, totalPremiumRequests: 1, totalApiDurationMs: 250 } }),
    ].join("\n"));

    expect(usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      totalProvenance: "derived-input-plus-output",
      cacheReadTokens: 3,
      totalNanoAiu: 6_506_145_000,
      aiCredits: 6.506145,
      costUsd: 0.06506145,
      premiumRequests: 1,
      durationMs: 250,
      completeness: "provider-json",
      provenance: "copilot-json-output",
    });
    expect(usage).not.toHaveProperty("cacheWriteTokens");
  });

  it("invokes only the selected skill and merges authoritative session shutdown telemetry", async () => {
    const root = runRoot();
    const stub = path.join(root, "copilot-stub.mjs");
    const log = path.join(root, "argv.jsonl");
    writeFileSync(stub, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
writeFileSync(process.env.OMP_STUB_LOG, JSON.stringify(args) + "\\n", { flag: "a" });
const sessionRoot = path.join(process.env.COPILOT_HOME, "session-state", "stub-session");
mkdirSync(sessionRoot, { recursive: true });
writeFileSync(path.join(sessionRoot, "events.jsonl"), JSON.stringify({
  type: "session.shutdown",
  data: {
    totalPremiumRequests: 1,
    totalApiDurationMs: 321,
    modelMetrics: {
      "gpt-5.5": {
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 10 }
      }
    }
  }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant.message", data: { outputTokens: 30, content: "ok" } }) + "\\n");
`);
    chmodSync(stub, 0o755);
    const originalBin = process.env.OMP_COPILOT_BIN;
    const originalLog = process.env.OMP_STUB_LOG;
    process.env.OMP_COPILOT_BIN = stub;
    process.env.OMP_STUB_LOG = log;
    try {
      const skillSource = runRoot();
      writeFileSync(path.join(skillSource, "SKILL.md"), "---\nname: history-analyze\ndescription: test\n---\n");
      writeFileSync(path.join(skillSource, "reference.txt"), "frozen\n");
      const plan = {
        ...basePlan(),
        executionProfile: { kind: "restricted" as const, allowlistedTools: ["view"] },
        selectedSkillPath: skillSource,
        selectedSkillFingerprint: directoryHash(skillSource),
      };
      const [baseline, skill] = buildMatchedExecutionCells(plan);
      ensureProviderWorkspace(baseline);
      ensureProviderWorkspace(skill);
      const baselineResult = await copilotProviderTransport(buildCandidateRequest(baseline));
      const skillResult = await copilotProviderTransport(buildCandidateRequest(skill));
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);

      expect(calls[0]).toContain("view");
      expect(calls[0]).not.toContain("skill");
      expect(calls[0].at(-1)).toContain("Do not use a benchmarked skill");
      expect(calls[1]).toContain("view,skill");
      expect(calls[1]).toContain("skill");
      expect(calls[1].at(-1)).toContain("/history-analyze");
      expect(skillResult.usage).toMatchObject({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        reasoningTokens: 10,
        totalTokens: 150,
        totalProvenance: "derived-input-plus-output",
        premiumRequests: 1,
        durationMs: 321,
        completeness: "provider-session-json",
        provenance: "copilot-session-events",
      });
      expect(skillResult.sessionTelemetry).toMatchObject({
        source: "copilot-session-events",
        eventType: "session.shutdown",
      });
      expect(baselineResult.status).toBe("complete");
    } finally {
      if (originalBin === undefined) delete process.env.OMP_COPILOT_BIN;
      else process.env.OMP_COPILOT_BIN = originalBin;
      if (originalLog === undefined) delete process.env.OMP_STUB_LOG;
      else process.env.OMP_STUB_LOG = originalLog;
    }
  });

  it("stops scheduling before the next cell when a hard ceiling is already reached and records frozen retry policy", () => {
    const cells = buildMatchedExecutionCells(basePlan());
    const decision = scheduleCellsWithinCeilings(cells, {
      spentUsd: 0,
      premiumRequests: 1,
      runtimeMs: 0,
      startedCells: 1,
      ceilings: { maxUsd: 1, maxPremiumRequests: 1, maxRuntimeMs: 60_000, maxCells: 4 },
      retryPolicy: { maxAttempts: 1, retryInfrastructure: false },
    });

    expect(decision.cellsToStart).toEqual([]);
    expect(decision.stopReason).toEqual({ family: "budget", detail: "premium-ceiling" });
    expect(decision.retryPolicy).toEqual({ maxAttempts: 1, retryInfrastructure: false, frozen: true });
  });

  it("stops before scheduling a near-USD-ceiling cell whose conservative estimate would overspend", () => {
    const cells = buildMatchedExecutionCells(basePlan());
    const decision = scheduleCellsWithinCeilings(cells, {
      spentUsd: 0.99,
      premiumRequests: 0,
      runtimeMs: 0,
      startedCells: 0,
      ceilings: { maxUsd: 1, maxPremiumRequests: 10, maxRuntimeMs: 60_000, maxCells: 10 },
      estimatedCell: { usd: 0.02, premiumRequests: 1, runtimeMs: 1_000 },
      retryPolicy: { maxAttempts: 2, retryInfrastructure: true },
    });

    expect(decision.cellsToStart).toEqual([]);
    expect(decision.stopReason).toEqual({ family: "budget", detail: "usd-ceiling" });
    expect(decision.retryPolicy).toEqual({ maxAttempts: 2, retryInfrastructure: true, frozen: true });
  });

  it("stops before scheduling a near-runtime-ceiling cell whose conservative estimate would exceed runtime", () => {
    const cells = buildMatchedExecutionCells(basePlan());
    const decision = scheduleCellsWithinCeilings(cells, {
      spentUsd: 0,
      premiumRequests: 0,
      runtimeMs: 59_000,
      startedCells: 0,
      ceilings: { maxUsd: 1, maxPremiumRequests: 10, maxRuntimeMs: 60_000, maxCells: 10 },
      estimatedCell: { usd: 0.001, premiumRequests: 1, runtimeMs: 2_000 },
      retryPolicy: { maxAttempts: 1, retryInfrastructure: false },
    });

    expect(decision.cellsToStart).toEqual([]);
    expect(decision.stopReason).toEqual({ family: "budget", detail: "runtime-ceiling" });
    expect(decision.retryPolicy).toEqual({ maxAttempts: 1, retryInfrastructure: false, frozen: true });
  });

  it("stops before scheduling a near-premium-ceiling cell whose conservative estimate would exceed premium requests", () => {
    const cells = buildMatchedExecutionCells(basePlan());
    const decision = scheduleCellsWithinCeilings(cells, {
      spentUsd: 0,
      premiumRequests: 4,
      runtimeMs: 0,
      startedCells: 0,
      ceilings: { maxUsd: 1, maxPremiumRequests: 5, maxRuntimeMs: 60_000, maxCells: 10 },
      estimatedCell: { usd: 0.001, premiumRequests: 2, runtimeMs: 1_000 },
      retryPolicy: { maxAttempts: 3, retryInfrastructure: true },
    });

    expect(decision.cellsToStart).toEqual([]);
    expect(decision.stopReason).toEqual({ family: "budget", detail: "premium-ceiling" });
    expect(decision.retryPolicy).toEqual({ maxAttempts: 3, retryInfrastructure: true, frozen: true });
  });

  it("stops before scheduling a matched batch when the next batch would exceed the cell ceiling", () => {
    const cells = buildMatchedExecutionCells(basePlan());
    const decision = scheduleCellsWithinCeilings(cells, {
      spentUsd: 0,
      premiumRequests: 0,
      runtimeMs: 0,
      startedCells: 3,
      ceilings: { maxUsd: 1, maxPremiumRequests: 10, maxRuntimeMs: 60_000, maxCells: 4 },
      estimatedCell: { usd: 0.001, premiumRequests: 1, runtimeMs: 1_000 },
      retryPolicy: { maxAttempts: 1, retryInfrastructure: false },
    });

    expect(cells).toHaveLength(2);
    expect(decision.cellsToStart).toEqual([]);
    expect(decision.stopReason).toEqual({ family: "budget", detail: "cell-ceiling" });
    expect(decision.retryPolicy).toEqual({ maxAttempts: 1, retryInfrastructure: false, frozen: true });
  });

  it("requires every evidence artifact before writing complete marker", () => {
    const root = runRoot();
    for (const artifact of ["request.json", "response.json", "result.json", "diff.patch", "tests.txt", "transcript.txt", "usage.json", "scorer.json", "timestamps.json"]) {
      writeFileSync(path.join(root, artifact), artifact);
    }

    expect(finalizeEvidenceBundle(root)).toEqual({ status: "complete", missingArtifacts: [] });
    expect(existsSync(path.join(root, "COMPLETE"))).toBe(true);

    const partial = runRoot();
    writeFileSync(path.join(partial, "request.json"), "{}");
    expect(finalizeEvidenceBundle(partial)).toEqual({ status: "incomplete-evidence", missingArtifacts: expect.arrayContaining(["response.json", "scorer.json"]) });
    expect(existsSync(path.join(partial, "COMPLETE"))).toBe(false);
  });

  it("classifies failures into quality process infrastructure availability quota scorer incomplete and parity buckets", () => {
    expect(classifyCellFailure({ evaluatorLabel: "quality" })).toBe("quality");
    expect(classifyCellFailure({ skillNotApplied: true })).toBe("process");
    expect(classifyCellFailure({ timeout: true })).toBe("infrastructure");
    expect(classifyCellFailure({ exitCode: null, signal: "SIGKILL" })).toBe("infrastructure");
    expect(classifyCellFailure({ partialOutput: true })).toBe("infrastructure");
    expect(classifyCellFailure({ unavailable: true })).toBe("availability");
    expect(classifyCellFailure({ quotaExceeded: true })).toBe("quota");
    expect(classifyCellFailure({ scorerFailure: true })).toBe("scorer");
    expect(classifyCellFailure({ incompleteEvidence: true })).toBe("incomplete");
    expect(classifyCellFailure({ parityInvalid: true })).toBe("parity-invalid");
  });
});
