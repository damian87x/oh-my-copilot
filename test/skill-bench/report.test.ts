import { describe, expect, it } from "vitest";
import { normalizeSkillBenchReport, renderSkillBenchReportHtml, renderSkillBenchReportJson } from "../../src/skill-bench/report.js";

const confidenceWinner = () => ({
  verdict: "winner" as const,
  noWinnerReason: null,
  interval: { lower: 0.08, mean: 0.17, upper: 0.25 },
  metadata: {
    familywiseAlpha: 0.05 as const,
    maxLooks: 2,
    currentLook: 1,
    comparisonFamilyId: "fam-alpha",
    comparisonCount: 3,
    alpha: 0.05 / 6,
    lowerQuantile: 0.05 / 12,
    upperQuantile: 1 - 0.05 / 12,
    frozenPairIds: ["baseline__prompt", "baseline__skill", "prompt__skill"],
    resamples: 10_000,
    seed: "spec-hash:baseline__skill",
    sampleCount: 6,
    coverage: 1 - 0.05 / 6,
  },
});

const baseRun = () => ({
  schemaVersion: 1 as const,
  runId: "run-20260714-alpha",
  mode: "validated" as const,
  status: "complete" as const,
  spec: {
    id: "spec-alpha",
    fingerprint: "spec-fp",
    evaluationFingerprint: "eval-fp",
    seed: "seed-123",
    rerunCommand: "omp skill-bench rerun run-20260714-alpha",
  },
  skill: { id: "skill-alpha", fingerprint: "skill-fp" },
  model: { id: "gpt-5.5", fingerprint: "model-fp" },
  environment: { provider: "synthetic", fingerprint: "env-fp" },
  pricing: { source: "public-snapshot", url: "https://prices.example/snap", retrievedAt: "2026-07-14T00:00:00Z", currency: "USD", completeness: "partial" },
  budget: { spentUsd: 0.16, expectedUsd: 0.24, maxUsd: 1, spentPremiumRequests: 2, expectedPremiumRequests: 3, maxPremiumRequests: 8 },
  warnings: ["cache-write tokens unavailable"],
  confidence: confidenceWinner(),
  cells: [
    {
      id: "baseline-expensive",
      taskId: "detect-api-regression",
      arm: "baseline",
      modelId: "gpt-5.5",
      status: "quality-failure",
      hardGatesPassed: false,
      qualityPassed: false,
      qualityScore: 0.48,
      costUsd: 0.01,
      latencyMs: 500,
      samples: 6,
      scenariosCovered: 2,
      scenariosRequired: 4,
      proofMatrix: {
        expected: ["reports sql injection"],
        found: ["<script>alert('x')</script>"],
        done: [],
        missed: ["auth bypass"],
        falsePositive: ["logs mention password"],
        incorrect: ["changed unrelated file"],
        proof: ["/tmp/private/evidence-baseline.json"],
      },
      evidencePaths: ["cells/baseline-expensive/evidence.json"],
      tokens: { input: 100, output: 50, completeness: "complete", provenance: "direct-session" },
    },
    {
      id: "skill-cheap",
      taskId: "detect-api-regression",
      arm: "skill",
      modelId: "gpt-5.5",
      status: "complete",
      hardGatesPassed: true,
      qualityPassed: true,
      qualityScore: 0.91,
      costUsd: 0.04,
      latencyMs: 1200,
      samples: 6,
      scenariosCovered: 4,
      scenariosRequired: 4,
      proofMatrix: {
        expected: ["reports sql injection", "reports auth bypass"],
        found: ["sql injection", "auth bypass"],
        done: ["attached line evidence"],
        missed: [],
        falsePositive: [],
        incorrect: [],
        proof: ["cells/skill-cheap/proof.json"],
      },
      evidencePaths: ["cells/skill-cheap/evidence.json"],
      tokens: { input: 110, output: 60, cachedRead: null, cacheWrite: null, reasoning: null, completeness: "partial", provenance: "provider-metadata" },
    },
    {
      id: "skill-quality",
      taskId: "detect-api-regression",
      arm: "skill",
      modelId: "gpt-5.6-sol",
      status: "complete",
      hardGatesPassed: true,
      qualityPassed: true,
      qualityScore: 0.97,
      costUsd: 0.12,
      latencyMs: 900,
      samples: 6,
      scenariosCovered: 4,
      scenariosRequired: 4,
      proofMatrix: { expected: [], found: [], done: ["all findings verified"], missed: [], falsePositive: [], incorrect: [], proof: ["cells/skill-quality/proof.json"] },
      evidencePaths: ["cells/skill-quality/evidence.json"],
      tokens: { input: 180, output: 80, completeness: "complete", provenance: "direct-session" },
    },
  ],
});

const completeMatchedRun = () => {
  const run = baseRun();
  return {
    ...run,
    cells: [
      {
        ...run.cells[0],
        id: "baseline-expensive",
        status: "complete" as const,
        hardGatesPassed: true,
        qualityPassed: true,
        qualityScore: 0.74,
        samples: 6,
        scenariosCovered: 4,
        scenariosRequired: 4,
        proofMatrix: { ...run.cells[0].proofMatrix, missed: [], falsePositive: [], incorrect: [] },
      },
      run.cells[1],
    ],
  };
};


describe("skill-bench decision-first report", () => {
  it("normalizes one report view model shared by JSON and HTML without opaque overall winners", () => {
    const view = normalizeSkillBenchReport(completeMatchedRun());

    expect(view.decision.state).toBe("pass");
    expect(view.decision.validated).toBe(true);
    expect(view.decision.noWinnerReason).toBeNull();
    expect(view.decision.overallWinner).toBeUndefined();
    expect(view.decision.cheapestPassing?.cellId).toBe("baseline-expensive");
    expect(view.decision.highestQuality?.cellId).toBe("skill-cheap");
    expect(view.decision.recommendedRoute).toBeNull();
    expect(view.decision.taskChoices).toEqual([
      expect.objectContaining({
        taskId: "detect-api-regression",
        state: "pass",
        cheapestPassing: expect.objectContaining({ modelId: "gpt-5.5", arm: "baseline" }),
        highestQuality: expect.objectContaining({ modelId: "gpt-5.5", arm: "skill" }),
      }),
    ]);
    expect(view.decision.matchedSkillUplift).toBeCloseTo(0.17);
    expect(view.decision.coverage).toMatchObject({ samples: 12, scenarioCoverage: "4/4" });
    expect(view.decision.confidence).toMatchObject({
      verdict: "winner",
      noWinnerReason: null,
      familywiseAlpha: 0.05,
      maxLooks: 2,
      currentLook: 1,
      comparisonFamilyId: "fam-alpha",
      comparisonCount: 3,
      alphaPerComparisonLook: 0.05 / 6,
      frozenPairIds: ["baseline__prompt", "baseline__skill", "prompt__skill"],
      resamples: 10_000,
      seed: "spec-hash:baseline__skill",
      sampleCount: 6,
      coverage: 1 - 0.05 / 6,
      interval: { lower: 0.08, mean: 0.17, upper: 0.25 },
    });
    expect(view.decision.decisiveMisses).toEqual([]);
    expect(view.decision.decisiveFalsePositives).toEqual([]);
    expect(JSON.stringify(view.proofMatrices)).not.toContain("/tmp/private");
    expect(view.proofMatrices[0].matrix.proof).toEqual(["[private-path]/evidence-baseline.json"]);
    expect(view.budget).toMatchObject({ spentUsd: 0.16, expectedUsd: 0.24, maxUsd: 1 });
    expect(view.provenance).toMatchObject({ manifestFingerprint: "spec-fp", evaluationFingerprint: "eval-fp", skillFingerprint: "skill-fp", modelFingerprint: "model-fp", environmentFingerprint: "env-fp", seed: "seed-123" });
    expect(renderSkillBenchReportJson(view)).toEqual(view);
  });

  it("keeps pilot and failed hard-gate reports from showing validated winners, recommendations, or apply", () => {
    const pilot = normalizeSkillBenchReport({ ...baseRun(), mode: "pilot" as const });
    expect(pilot.decision.state).toBe("inconclusive");
    expect(pilot.decision.validated).toBe(false);
    expect(pilot.recommendation).toBeNull();
    expect(pilot.actions.canApply).toBe(false);
    expect(pilot.decision.noWinnerReason).toContain("pilot");
    expect(pilot.decision.confidence.verdict).toBe("inconclusive");
    expect(pilot.decision.confidence.noWinnerReason).toContain("pilot");

    const failed = normalizeSkillBenchReport({ ...baseRun(), cells: baseRun().cells.map((cell) => ({ ...cell, hardGatesPassed: false, status: "quality-failure" })) });
    expect(failed.decision.cheapestPassing).toBeNull();
    expect(failed.decision.highestQuality).toBeNull();
    expect(failed.decision.noWinnerReason).toContain("no hard-gate passing cell");
  });

  it("does not label below-threshold or unknown-cost rows as cheapest passing", () => {
    const run = completeMatchedRun();
    const cells = run.cells.map((cell) => ({
      ...cell,
      status: "complete" as const,
      hardGatesPassed: true,
      qualityPassed: false,
      qualityScore: 0,
      costUsd: null,
      proofMatrix: { ...cell.proofMatrix, missed: ["approved quality requirement"] },
    }));
    const view = normalizeSkillBenchReport({ ...run, mode: "pilot" as const, cells });

    expect(view.decision.cheapestPassing).toBeNull();
    expect(view.decision.highestQuality).not.toBeNull();
    expect(view.decision.taskChoices).toEqual([
      expect.objectContaining({
        taskId: "detect-api-regression",
        state: "fail",
        cheapestPassing: null,
      }),
    ]);
    expect(view.rows.every((row) => row.statusText.includes("QUALITY FAIL"))).toBe(true);
  });

  it("fails closed when persisted report cells omit the explicit quality gate", () => {
    const run = completeMatchedRun();
    const cells = run.cells.map(({ qualityPassed: _qualityPassed, ...cell }) => cell);
    const view = normalizeSkillBenchReport({ ...run, cells } as never);

    expect(view.decision.cheapestPassing).toBeNull();
    expect(view.decision.taskChoices[0]).toMatchObject({ state: "fail", cheapestPassing: null });
    expect(view.rows.every((row) => row.qualityPassed === false)).toBe(true);
    expect(view.rows.every((row) => row.statusText.includes("QUALITY FAIL"))).toBe(true);
  });

  it("keeps validated reports inconclusive when confidence statistics are missing", () => {
    const run = completeMatchedRun();
    const view = normalizeSkillBenchReport({ ...run, confidence: undefined });

    expect(view.mode).toBe("validated");
    expect(view.decision.state).toBe("inconclusive");
    expect(view.decision.validated).toBe(false);
    expect(view.decision.confidence.verdict).toBe("inconclusive");
    expect(view.decision.confidence.noWinnerReason).toContain("missing confidence statistics");
    expect(view.recommendation).toBeNull();
    expect(view.actions.canApply).toBe(false);
  });

  it("fails closed and surfaces no-winner reason when confidence metadata has malformed alpha quantiles frozen pairs or samples", () => {
    const malformedRuns = [
      { label: "alpha", confidence: { ...confidenceWinner(), metadata: { ...confidenceWinner().metadata, alpha: 0.05 / 2 } } },
      { label: "quantiles", confidence: { ...confidenceWinner(), metadata: { ...confidenceWinner().metadata, lowerQuantile: 0.025, upperQuantile: 0.975 } } },
      { label: "frozen pairs", confidence: { ...confidenceWinner(), metadata: { ...confidenceWinner().metadata, comparisonCount: 2, frozenPairIds: ["baseline__skill", "dynamic__skill"] } } },
      { label: "samples", confidence: { ...confidenceWinner(), metadata: { ...confidenceWinner().metadata, sampleCount: 5 } } },
    ];

    for (const { label, confidence } of malformedRuns) {
      const view = normalizeSkillBenchReport({ ...completeMatchedRun(), confidence });
      expect(view.decision.state, label).toBe("inconclusive");
      expect(view.decision.validated, label).toBe(false);
      expect(view.recommendation, label).toBeNull();
      expect(view.actions.canApply, label).toBe(false);
      expect(view.decision.noWinnerReason, label).toContain("confidence metadata invalid");
      expect(view.decision.confidence.verdict, label).toBe("inconclusive");
      expect(view.decision.confidence.noWinnerReason, label).toContain("confidence metadata invalid");
    }
  });

  it("renders invalid confidence metadata as no-winner in HTML and JSON", () => {
    const view = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      confidence: { ...confidenceWinner(), metadata: { ...confidenceWinner().metadata, alpha: 0.05 / 2 } },
    });
    const json = renderSkillBenchReportJson(view);
    const html = renderSkillBenchReportHtml(view);

    expect(json.decision.noWinnerReason).toContain("confidence metadata invalid");
    expect(json.decision.confidence.noWinnerReason).toContain("confidence metadata invalid");
    expect(html).toContain("Overall status");
    expect(html).toContain('class="status-inconclusive">inconclusive</span>');
    expect(html).toContain("Confidence verdict: inconclusive");
    expect(html).toContain("No winner reason: confidence metadata invalid");
  });

  it("keeps validated tie/no-winner reports inconclusive with explicit confidence metadata", () => {
    const run = completeMatchedRun();
    const tie = normalizeSkillBenchReport({
      ...run,
      confidence: {
        ...confidenceWinner(),
        verdict: "tie" as const,
        noWinnerReason: "family-adjusted interval is within practical tie margin",
        interval: { lower: -0.01, mean: 0, upper: 0.01 },
      },
    });

    expect(tie.decision.state).toBe("inconclusive");
    expect(tie.decision.validated).toBe(false);
    expect(tie.decision.noWinnerReason).toContain("family-adjusted interval");
    expect(tie.decision.confidence.verdict).toBe("tie");
    expect(tie.decision.confidence.noWinnerReason).toContain("practical tie");
    expect(tie.recommendation).toBeNull();
    expect(tie.actions.canApply).toBe(false);
  });


  it("does not validate a lone passing skill cell without a complete parity-valid baseline match", () => {
    const view = normalizeSkillBenchReport({ ...baseRun(), cells: [baseRun().cells[1]] });

    expect(view.decision.state).toBe("inconclusive");
    expect(view.decision.validated).toBe(false);
    expect(view.decision.noWinnerReason).toContain("matched baseline and skill");
    expect(view.decision.cheapestPassing).toBeNull();
    expect(view.decision.highestQuality).toBeNull();
    expect(view.decision.matchedSkillUplift).toBeNull();
    expect(view.recommendation).toBeNull();
    expect(view.actions.canApply).toBe(false);
  });

  it("validates only matched baseline and skill complete parity-valid units with required coverage", () => {
    const valid = normalizeSkillBenchReport(completeMatchedRun());
    expect(valid.decision.state).toBe("pass");
    expect(valid.decision.validated).toBe(true);
    expect(valid.decision.noWinnerReason).toBeNull();
    expect(valid.decision.matchedSkillUplift).toBeCloseTo(0.17);

    const incompleteCoverage = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      cells: completeMatchedRun().cells.map((cell) => (cell.id === "baseline-expensive" ? { ...cell, scenariosCovered: 3 } : cell)),
    });
    expect(incompleteCoverage.decision.state).toBe("inconclusive");
    expect(incompleteCoverage.decision.validated).toBe(false);
    expect(incompleteCoverage.decision.noWinnerReason).toContain("coverage");

    const parityInvalid = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      cells: completeMatchedRun().cells.map((cell) => (cell.id === "baseline-expensive" ? { ...cell, status: "parity-invalid" as const } : cell)),
    });
    expect(parityInvalid.decision.state).toBe("inconclusive");
    expect(parityInvalid.decision.validated).toBe(false);
    expect(parityInvalid.decision.noWinnerReason).toContain("matched baseline and skill");
  });

  it("keeps non-quality cells visible in tallies while excluding them from quality rankings and uplift", () => {
    const run = completeMatchedRun();
    const invalidSkill = {
      ...run.cells[1],
      id: "skill-invalid-high-score",
      taskId: "detect-other-regression",
      status: "scorer-failure" as const,
      hardGatesPassed: true,
      qualityScore: 1,
      proofMatrix: { ...run.cells[1].proofMatrix, missed: ["scorer crashed"], falsePositive: ["phantom vuln"] },
    };
    const incompleteInfra = {
      ...run.cells[0],
      id: "baseline-infra-incomplete",
      taskId: "detect-other-regression",
      status: "infrastructure-failure" as const,
      hardGatesPassed: false,
      qualityScore: 0.99,
      scenariosCovered: 0,
      proofMatrix: { ...run.cells[0].proofMatrix, missed: ["infra missing evidence"], falsePositive: [] },
    };
    const view = normalizeSkillBenchReport({ ...run, cells: [...run.cells, invalidSkill, incompleteInfra] });

    expect(view.decision.state).toBe("pass");
    expect(view.rows.map((row) => row.cellId)).toContain("skill-invalid-high-score");
    expect(view.rows.map((row) => row.cellId)).toContain("baseline-infra-incomplete");
    expect(view.decision.decisiveMisses).toContain("scorer crashed");
    expect(view.decision.decisiveMisses).toContain("infra missing evidence");
    expect(view.decision.decisiveFalsePositives).toContain("phantom vuln");
    expect(view.decision.highestQuality?.cellId).not.toBe("skill-invalid-high-score");
    expect(view.decision.matchedSkillUplift).toBeCloseTo(0.17);
  });

  it("orders rows by task then passing state and cheapest cost", () => {
    const run = completeMatchedRun();
    const aTask = run.cells.map((cell, index) => ({
      ...cell,
      id: `a-task-${cell.arm}-${index}`,
      taskId: "a-task",
      costUsd: cell.arm === "baseline" ? 0.03 : 0.02,
      scenariosCovered: 1,
      scenariosRequired: 1,
    }));
    const zTask = run.cells.map((cell, index) => ({
      ...cell,
      id: `z-task-${cell.arm}-${index}`,
      taskId: "z-task",
      costUsd: cell.arm === "baseline" ? 0.01 : 0.04,
      scenariosCovered: 1,
      scenariosRequired: 1,
    }));

    const view = normalizeSkillBenchReport({ ...run, cells: [...zTask, ...aTask] });

    expect(view.rows.map((row) => `${row.taskId}:${row.costUsd}`)).toEqual([
      "a-task:0.02",
      "a-task:0.03",
      "z-task:0.01",
      "z-task:0.04",
    ]);
    expect(view.decision.coverage.scenarioCoverage).toBe("2/2");
  });

  it("renders accessible escaped HTML from the same model and never lets browser-open state affect generation", () => {
    const view = normalizeSkillBenchReport(completeMatchedRun());
    const html = renderSkillBenchReportHtml(view, { browserOpen: { attempted: true, ok: false, error: "no browser" } });

    expect(html).toContain("<h1>Skill Bench Decision Report</h1>");
    expect(html).toContain('<meta name="description" content="Decision-first quality, cost, token, and latency evidence for a skill benchmark run.">');
    expect(html).toContain("<main>");
    expect(html).toContain("Overall status");
    expect(html).toContain('class="status-pass">pass</span>');
    expect(html).toContain("<strong>Mode</strong><span>validated</span>");
    expect(html).toContain("Confidence verdict: winner");
    expect(html).toContain("Recommended route:</strong> none — this run does not support an approved routing recommendation");
    expect(html).toContain('aria-label="Per-task choices"');
    expect(html).toContain("gpt-5.5 / baseline; quality 74%; cost $0.01");
    expect(html).toContain("Familywise alpha: 0.05");
    expect(html).toContain("Adjusted alpha per comparison/look: 0.008333333333333333");
    expect(html).toContain("Look: 1/2");
    expect(html).toContain("Comparison family: fam-alpha");
    expect(html).toContain("Frozen comparisons: baseline__prompt, baseline__skill, prompt__skill");
    expect(html).toContain("Confidence interval: 0.08..0.25 (mean 0.17)");
    expect(html).toContain("Matched skill uplift</strong><span>0.17</span>");
    expect(html).toContain("aria-label=\"Decision summary\"");
    expect(html).toContain("<th scope=\"col\">Task</th>");
    expect(html).toContain("<th scope=\"col\">Setup</th>");
    expect(html).toContain("<th scope=\"col\">Tested agent (model)</th>");
    expect(html).toContain("<th scope=\"col\">Est. cost USD</th>");
    expect(html).toContain('aria-label="Quality versus estimated cost chart"');
    expect(html).toContain('aria-label="Total tokens chart"');
    expect(html).toContain("Provider total when available; otherwise input + output. Cache-read tokens are already included in input.");
    expect(html).toContain('aria-label="Latency chart"');
    expect(html).toContain("Cost basis");
    expect(html).toContain('href="https://prices.example/snap"');
    expect(html).toContain("Public-price proxy; not a GitHub Copilot invoice");
    expect(html).toContain("provider-metadata / partial");
    expect(html).toContain("Input 110");
    expect(html).toContain("cache write unknown");
    expect(html).toContain("class=\"wrap\"");
    for (const cellId of ["baseline-expensive", "skill-cheap"]) {
      expect(html).toContain(`Cell ${cellId}`);
    }
    expect(html).toContain("[private-path]/evidence-baseline.json");
    expect(html).not.toContain("/tmp/private");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Browser open failed: no browser");
    expect(html).toContain("Pricing snapshot: public-snapshot https://prices.example/snap 2026-07-14T00:00:00Z USD partial");
    expect(html).toContain("Exact rerun: omp skill-bench rerun run-20260714-alpha");
  });

  it("pairs monetary cost with total token spend across decision surfaces", () => {
    const html = renderSkillBenchReportHtml(normalizeSkillBenchReport(completeMatchedRun()));

    expect(html).toContain("<th scope=\"col\">Cheapest passing (cost + tokens)</th>");
    expect(html).toContain("<th scope=\"col\">Highest quality (cost + tokens)</th>");
    expect(html).toContain("gpt-5.5 / baseline; quality 74%; cost $0.01; tokens 150");
    expect(html).toContain("gpt-5.5 / skill; quality 91%; cost $0.04; tokens 170");
    expect(html).toContain("<strong>Token basis</strong>");
    expect(html).toContain("<strong>Baseline · gpt-5.5</strong> 74% · $0.01 · 150 tokens");
    expect(html).toContain("estimated cost $0.01, total tokens 150, quality pass");
    expect(html).toContain("<th scope=\"col\">Est. cost USD</th><th scope=\"col\">Total tokens</th>");
  });

  it("leads with a plain-language run outcome for pilot and budget-stop cases", () => {
    const pilotHtml = renderSkillBenchReportHtml(
      normalizeSkillBenchReport({ ...completeMatchedRun(), mode: "pilot" as const }),
    );
    expect(pilotHtml).toContain('aria-label="Run outcome"');
    expect(pilotHtml).toContain("Pilot complete — evidence only");
    expect(pilotHtml).toContain("What next");
    expect(pilotHtml).toContain("Machine status detail");

    const budgetView = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      mode: "pilot" as const,
      warnings: ["budget stopped before next matched batch: usd-ceiling"],
    });
    budgetView.decision.noWinnerReason = "budget stopped before next matched batch: usd-ceiling";
    const budgetHtml = renderSkillBenchReportHtml(budgetView);
    expect(budgetHtml).toContain("Stopped early — budget ceiling reached");
    expect(budgetHtml).toContain("USD hard ceiling was reached");
    expect(budgetHtml).toContain("Technical reason");

    const salvageView = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      mode: "pilot" as const,
      warnings: ["salvaged from partial run: report rebuilt from on-disk cell evidence"],
    });
    const salvageHtml = renderSkillBenchReportHtml(salvageView);
    expect(salvageHtml).toContain("Partial report rebuilt from cell evidence");
  });

  it("renders pilot reports as a compact decision view with expandable technical detail", () => {
    const view = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      mode: "pilot" as const,
    });
    const html = renderSkillBenchReportHtml(view);

    expect(html).toContain("Pilot result — no validated winner yet");
    expect(html).not.toContain("Familywise alpha:");
    expect(html).toContain("Performance at a glance");
    expect(html).toContain('aria-label="Quality versus estimated cost chart"');
    expect(html).toContain('aria-label="Cell comparison"');
    expect(html).toContain("Full usage and provenance");
    expect(html).toContain("Input 100");
    expect(html).toContain("Output 50");
    expect(html).toContain("Cell baseline-expensive");
  });

  it("keeps equal-quality chart labels separated and inside the plot", () => {
    const run = completeMatchedRun();
    const source = run.cells[1];
    const longModelId = `provider-${"very-long-model-segment-".repeat(4)}tail`;
    const cells = [
      { ...source, id: "same-quality-1", arm: "skill" as const, modelId: "model-alpha", costUsd: 0.01 },
      { ...source, id: "same-quality-2", arm: "baseline" as const, modelId: "model-beta", costUsd: 0.02 },
      { ...source, id: "same-quality-3", arm: "skill" as const, modelId: "model-gamma", costUsd: 0.03 },
      { ...source, id: "same-quality-4", arm: "baseline" as const, modelId: longModelId, costUsd: 0.04 },
    ].map((cell) => ({ ...cell, qualityScore: 1, qualityPassed: true }));
    const html = renderSkillBenchReportHtml(normalizeSkillBenchReport({ ...run, cells }));
    const labelY = [...html.matchAll(/<text class="point-label"[^>]* y="([0-9.]+)"/g)]
      .map((match) => Number(match[1]));
    const modelLabels = [...html.matchAll(/<tspan class="point-label-model"[^>]* textLength="([0-9.]+)"[^>]*>([^<]+)<\/tspan>/g)];

    expect(labelY).toHaveLength(4);
    expect(new Set(labelY).size).toBe(4);
    expect(Math.min(...labelY)).toBeGreaterThanOrEqual(26);
    expect(Math.max(...labelY)).toBeLessThanOrEqual(250);
    expect(html.match(/class="point-leader"/g)).toHaveLength(4);
    expect(modelLabels).toHaveLength(4);
    expect(modelLabels.every((match) => Number(match[1]) <= 204)).toBe(true);
    expect(modelLabels.some((match) => match[2].includes("…"))).toBe(true);
    expect(html).toContain(longModelId);
  });

  it("renders mode, confidence no-winner reason, proof matrix, and escapes confidence output", () => {
    const view = normalizeSkillBenchReport({
      ...completeMatchedRun(),
      confidence: {
        ...confidenceWinner(),
        verdict: "inconclusive" as const,
        noWinnerReason: "<script>alert('tie')</script> no decisive family-adjusted interval",
        interval: null,
      },
    });
    const html = renderSkillBenchReportHtml(view);

    expect(html).toContain('class="status-inconclusive">inconclusive</span>');
    expect(html).toContain("<strong>Mode</strong><span>validated</span>");
    expect(html).toContain("Confidence verdict: inconclusive");
    expect(html).toContain("No winner reason: &lt;script&gt;alert(&#39;tie&#39;)&lt;/script&gt; no decisive family-adjusted interval");
    expect(html).toContain("detect-api-regression / baseline / gpt-5.5");
    expect(html).not.toContain("<script>alert");
  });
});
