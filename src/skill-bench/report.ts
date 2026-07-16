import path from "node:path";
import { validateConsensusRevision2MetadataFields, type ConsensusRevision2Metadata } from "./statistics.js";

export type SkillBenchRunMode = "pilot" | "validated";
export type ReportDecisionState = "pass" | "fail" | "inconclusive";

type CellStatus = "complete" | "quality-failure" | "process-failure" | "infrastructure-failure" | "availability-failure" | "quota-failure" | "scorer-failure" | "incomplete" | "parity-invalid";

export interface ProofMatrixView {
  expected: string[];
  found: string[];
  done: string[];
  missed: string[];
  falsePositive: string[];
  incorrect: string[];
  proof: string[];
}

export type ReportConfidenceVerdict = "winner" | "tie" | "inconclusive";

export interface ReportConfidenceInput {
  verdict: ReportConfidenceVerdict;
  noWinnerReason: string | null;
  interval: { lower: number; mean: number; upper: number } | null;
  metadata: ConsensusRevision2Metadata;
}

export interface ReportCellInput {
  id: string;
  taskId: string;
  arm: string;
  modelId: string;
  status: CellStatus;
  hardGatesPassed: boolean;
  qualityPassed: boolean;
  qualityScore: number;
  costUsd: number | null;
  latencyMs: number | null;
  samples: number;
  scenariosCovered: number;
  scenariosRequired: number;
  proofMatrix: ProofMatrixView;
  evidencePaths: string[];
  tokens: Record<string, unknown> & { completeness: string; provenance: string };
}

export interface SkillBenchReportInput {
  schemaVersion: 1;
  runId: string;
  mode: SkillBenchRunMode;
  status: string;
  spec: { id: string; fingerprint: string; evaluationFingerprint: string; seed: string; rerunCommand: string };
  skill: { id: string; fingerprint: string };
  model: { id: string; fingerprint: string };
  environment: { provider: string; fingerprint: string };
  pricing: { source: string; url?: string | null; retrievedAt?: string | null; currency?: string | null; completeness: string };
  budget: Record<string, number | string | null>;
  warnings: string[];
  confidence?: ReportConfidenceInput;
  cells: ReportCellInput[];
}

export interface ReportRankingCell {
  cellId: string;
  taskId: string;
  arm: string;
  modelId: string;
  qualityScore: number;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface SkillBenchReportView {
  schemaVersion: 1;
  runId: string;
  mode: SkillBenchRunMode;
  decision: {
    mode: SkillBenchRunMode;
    state: ReportDecisionState;
    validated: boolean;
    cheapestPassing: ReportRankingCell | null;
    highestQuality: ReportRankingCell | null;
    matchedSkillUplift: number | null;
    coverage: { samples: number; scenarioCoverage: string };
    decisiveMisses: string[];
    decisiveFalsePositives: string[];
    noWinnerReason: string | null;
    recommendedRoute: null | {
      skillId: string;
      modelId: string;
      objective: string;
    };
    taskChoices: Array<{
      taskId: string;
      state: ReportDecisionState;
      cheapestPassing: ReportRankingCell | null;
      highestQuality: ReportRankingCell | null;
    }>;
    confidence: {
      verdict: ReportConfidenceVerdict;
      noWinnerReason: string | null;
      familywiseAlpha: number;
      maxLooks: number;
      currentLook: number;
      comparisonFamilyId: string;
      comparisonCount: number;
      alphaPerComparisonLook: number;
      lowerQuantile: number;
      upperQuantile: number;
      frozenPairIds: string[];
      resamples: number;
      seed: string;
      sampleCount: number;
      coverage: number;
      interval: { lower: number; mean: number; upper: number } | null;
    };
  };
  budget: Record<string, number | string | null>;
  tokenCostCompleteness: Array<{ cellId: string; completeness: string; provenance: string; categories: string[] }>;
  proofMatrices: Array<{ cellId: string; matrix: ProofMatrixView; evidencePaths: string[] }>;
  provenance: {
    manifestFingerprint: string;
    evaluationFingerprint: string;
    skillFingerprint: string;
    modelFingerprint: string;
    environmentFingerprint: string;
    seed: string;
    rerunId: string;
    rerunCommand: string;
    pricingSnapshot: SkillBenchReportInput["pricing"];
    warnings: string[];
  };
  recommendation: null | { evidencePath: string };
  actions: { canApply: boolean };
  rows: Array<
    ReportRankingCell & {
      status: CellStatus;
      statusText: string;
      hardGatesPassed: boolean;
      qualityPassed: boolean;
      tokens: ReportCellInput["tokens"];
    }
  >;
}

export function normalizeSkillBenchReport(input: SkillBenchReportInput): SkillBenchReportView {
  const qualityCells = eligibleMatchedQualityCells(input.cells);
  const cheapestPassing = firstOrNull(
    qualityCells
      .filter((cell) => qualityGatePassed(cell) && isFiniteNumber(cell.costUsd))
      .sort(compareCheapest)
      .map(toRanking),
  );
  const highestQuality = firstOrNull([...qualityCells].sort(compareQuality).map(toRanking));
  const matchedSkillUplift = computeMatchedSkillUplift(input.cells);
  const samples = input.cells.reduce((sum, cell) => sum + safeNumber(cell.samples), 0);
  const matchedQualitySamples = matchedConfidenceSamples(input.cells);
  const scenarioCoverage = summarizeScenarioCoverage(input.cells);
  const decisiveMisses = unique(input.cells.flatMap((cell) => cell.proofMatrix.missed));
  const decisiveFalsePositives = unique(input.cells.flatMap((cell) => cell.proofMatrix.falsePositive));
  const confidence = normalizeConfidence(input.mode, input.confidence, matchedQualitySamples);
  const noWinnerReason = winnerBlockReason(input.mode, qualityCells.length, input.cells, confidence);
  const validated = input.mode === "validated" && noWinnerReason === null;
  let state: ReportDecisionState = "inconclusive";
  if (validated) {
    state = "pass";
  } else if (input.mode === "validated" && !hasAnyHardGatePassingCell(input.cells)) {
    state = "fail";
  }
  const taskChoices = taskChoiceRows(input.cells);
  const decisionConfidence =
    noWinnerReason === null
      ? confidence
      : {
          ...confidence,
          verdict: confidence.verdict === "winner" ? "inconclusive" : confidence.verdict,
          noWinnerReason,
        };

  return {
    schemaVersion: 1,
    runId: input.runId,
    mode: input.mode,
    decision: {
      mode: input.mode,
      state,
      validated,
      cheapestPassing,
      highestQuality,
      matchedSkillUplift,
      coverage: { samples, scenarioCoverage },
      decisiveMisses,
      decisiveFalsePositives,
      noWinnerReason,
      recommendedRoute: null,
      taskChoices,
      confidence: decisionConfidence,
    },
    budget: { ...input.budget },
    tokenCostCompleteness: input.cells.map((cell) => ({
      cellId: cell.id,
      completeness: String(cell.tokens.completeness),
      provenance: String(cell.tokens.provenance),
      categories: Object.keys(cell.tokens).filter((key) => !["completeness", "provenance"].includes(key)).sort(),
    })),
    proofMatrices: input.cells.map((cell) => ({
      cellId: cell.id,
      matrix: cloneMatrix(cell.proofMatrix),
      evidencePaths: cell.evidencePaths.map(redactPrivatePath),
    })),
    provenance: {
      manifestFingerprint: input.spec.fingerprint,
      evaluationFingerprint: input.spec.evaluationFingerprint,
      skillFingerprint: input.skill.fingerprint,
      modelFingerprint: input.model.fingerprint,
      environmentFingerprint: input.environment.fingerprint,
      seed: input.spec.seed,
      rerunId: input.runId,
      rerunCommand: input.spec.rerunCommand,
      pricingSnapshot: { ...input.pricing },
      warnings: [...input.warnings],
    },
    recommendation: validated ? { evidencePath: `${input.runId}/recommendation.json` } : null,
    actions: { canApply: validated },
    rows: [...input.cells]
      .sort(
        (a, b) =>
          a.taskId.localeCompare(b.taskId) ||
          Number(qualityGatePassed(b)) - Number(qualityGatePassed(a)) ||
          Number(b.hardGatesPassed) - Number(a.hardGatesPassed) ||
          compareCheapest(a, b) ||
          a.modelId.localeCompare(b.modelId) ||
          a.arm.localeCompare(b.arm) ||
          a.id.localeCompare(b.id),
      )
      .map((cell) => ({
        ...toRanking(cell),
        status: cell.status,
        statusText: statusText(cell),
        hardGatesPassed: cell.hardGatesPassed,
        qualityPassed: qualityGatePassed(cell),
        tokens: { ...cell.tokens },
      })),
  };
}

export function renderSkillBenchReportJson(view: SkillBenchReportView): SkillBenchReportView {
  return view;
}

export function renderSkillBenchReportHtml(view: SkillBenchReportView, options: { browserOpen?: { attempted: boolean; ok: boolean; error?: string } } = {}): string {
  const browserLine = options.browserOpen?.attempted
    ? options.browserOpen.ok
      ? "Browser open succeeded"
      : `Browser open failed: ${options.browserOpen.error ?? "unknown"}`
    : "Browser open not attempted";
  const pricing = view.provenance.pricingSnapshot;
  const proxyPricing = isProxyPricing(pricing.source);
  const pricingUrl = safeWebUrl(pricing.url);
  const chosenCellIds = new Set(
    view.decision.taskChoices.flatMap((choice) =>
      choice.cheapestPassing ? [choice.cheapestPassing.cellId] : [],
    ),
  );
  const confidenceHtml =
    view.mode === "pilot"
      ? `<p class="pilot-note"><strong>Pilot result — no validated winner yet.</strong> This run checks the approved scenario and reports observed quality, usage, and cost. Run validated mode before applying routing.</p>`
      : `<details class="technical" open><summary>Validated confidence details</summary>
<div class="detail-grid">
<p>Confidence verdict: ${escapeHtml(view.decision.confidence.verdict)}</p>
<p>Familywise alpha: ${escapeHtml(formatNumber(view.decision.confidence.familywiseAlpha))}</p>
<p>Adjusted alpha per comparison/look: ${escapeHtml(formatNumber(view.decision.confidence.alphaPerComparisonLook))}</p>
<p>Look: ${escapeHtml(`${view.decision.confidence.currentLook}/${view.decision.confidence.maxLooks}`)}</p>
<p>Comparison family: ${escapeHtml(view.decision.confidence.comparisonFamilyId)}</p>
<p>Comparison count: ${escapeHtml(formatNumber(view.decision.confidence.comparisonCount))}</p>
<p>Quantiles: ${escapeHtml(`${formatNumber(view.decision.confidence.lowerQuantile)}..${formatNumber(view.decision.confidence.upperQuantile)}`)}</p>
<p>Frozen comparisons: ${escapeHtml(listOrNone(view.decision.confidence.frozenPairIds))}</p>
<p>Bootstrap: ${escapeHtml(`${formatNumber(view.decision.confidence.resamples)} resamples, seed ${view.decision.confidence.seed}`)}</p>
<p>Confidence sample/coverage: ${escapeHtml(`${formatNumber(view.decision.confidence.sampleCount)} samples, coverage ${formatNumber(view.decision.confidence.coverage)}`)}</p>
<p>Confidence interval: ${escapeHtml(formatInterval(view.decision.confidence.interval))}</p>
</div></details>`;
  const warningsHtml = view.provenance.warnings.length > 0
    ? `<aside class="run-warnings"><strong>Run warnings</strong><ul>${view.provenance.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></aside>`
    : "";
  const comparisonRows = view.rows
    .map(
      (row) => `<tr>
<th scope="row">${escapeHtml(row.taskId)}</th>
<td><span class="setup-badge setup-${armClass(row.arm)}">${escapeHtml(titleCase(row.arm))}</span>${chosenCellIds.has(row.cellId) ? `<span class="best-badge">Cheapest pass</span>` : ""}</td>
<td class="wrap"><strong>${escapeHtml(row.modelId)}</strong></td>
<td><strong class="number">${escapeHtml(formatQuality(row.qualityScore))}</strong><span class="gate status-${row.qualityPassed ? "pass" : "fail"}">${row.qualityPassed ? "PASS" : "FAIL"}</span></td>
<td class="number">${escapeHtml(formatUsd(row.costUsd))}</td>
<td class="number">${escapeHtml(formatTokenCount(row.tokens, ["total", "totalTokens"]))}</td>
<td class="number">${escapeHtml(formatLatency(row.latencyMs))}</td>
<td><details class="row-details"><summary>View</summary>
<p><strong>Cell ${escapeHtml(row.cellId)}</strong></p>
<p>${escapeHtml(row.statusText)}</p>
<p>Input ${escapeHtml(formatToken(row.tokens, ["input", "inputTokens"]))}; cache read ${escapeHtml(formatToken(row.tokens, ["cacheRead", "cachedRead", "cacheReadTokens", "cachedInputTokens"]))}; cache write ${escapeHtml(formatToken(row.tokens, ["cacheWrite", "cacheWriteTokens"]))}; Output ${escapeHtml(formatToken(row.tokens, ["output", "outputTokens"]))}; reasoning ${escapeHtml(formatToken(row.tokens, ["reasoning", "reasoningTokens"]))}; total ${escapeHtml(formatTokenCount(row.tokens, ["total", "totalTokens"]))} (${escapeHtml(tokenTotalProvenance(row.tokens))}).</p>
<p>Premium requests ${escapeHtml(formatToken(row.tokens, ["premiumRequests"]))}; latency ${escapeHtml(formatMetric(row.latencyMs))} ms.</p>
<p>Telemetry: ${escapeHtml(`${String(row.tokens.provenance)} / ${String(row.tokens.completeness)}; cost ${String(row.tokens.costProvenance ?? "unknown")}`)}</p>
</details></td>
</tr>`,
    )
    .join("\n");
  const chartsHtml = renderDecisionCharts(view.rows);
  const pricingSourceHtml = pricingUrl
    ? `<a href="${escapeHtml(pricingUrl)}">${escapeHtml(pricing.source)}</a>`
    : escapeHtml(pricing.source);
  const proofHtml = view.proofMatrices
    .map((proof) => {
      const row = view.rows.find((candidate) => candidate.cellId === proof.cellId);
      const label = row
        ? `${row.taskId} / ${row.arm} / ${row.modelId}`
        : proof.cellId;
      return `<details class="proof"><summary>${escapeHtml(label)}</summary><p class="wrap">Cell ${escapeHtml(proof.cellId)}</p>${renderMatrix(proof.matrix)}</details>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Decision-first quality, cost, token, and latency evidence for a skill benchmark run.">
<title>Skill Bench Decision Report</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb;--skill:#215cce;--baseline:#66758a;--prompt:#a55b09;--other:#6f50b5}
body{max-width:1240px;margin:0 auto;padding:32px;line-height:1.5}h1,h2,h3{line-height:1.2}h1{margin-bottom:.2rem}.run-id{margin-top:0;color:#52627a;font:600 .82rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
section,table,details.technical{background:#fff;border:1px solid #d9e1ec;border-radius:12px;box-shadow:0 4px 16px rgba(34,52,84,.06)}
section{padding:22px;margin:18px 0}.help{color:#44546a;background:#eef4ff;border-left:4px solid #3b6eea;padding:12px 16px}.pilot-note,.run-warnings{background:#fff7df;border-left:4px solid #c88700;padding:12px 16px}.run-warnings ul{margin:.4rem 0 0;padding-left:1.25rem}
.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}.metric{background:#f7f9fc;border:1px solid #e2e8f0;border-radius:10px;padding:12px}.metric strong{display:block;font-size:.78rem;color:#52627a;text-transform:uppercase;letter-spacing:.04em}.metric span{font-size:1.05rem;font-weight:700}
.cost-basis{display:grid;grid-template-columns:minmax(150px,.35fr) 1fr;gap:8px 20px;align-items:center;margin:18px 0;padding:14px 16px;border:1px solid #b9cbee;border-radius:10px;background:#f3f7ff}.cost-basis strong{display:block;color:#264f9d}.cost-basis p{margin:0}.cost-basis .proxy-note{font-weight:700;color:#704800}.cost-basis a{color:#164fb8}
.charts-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.chart-card{margin:0;padding:16px;border:1px solid #d9e1ec;border-radius:12px;background:#fbfcff}.chart-card-wide{grid-column:1/-1}.chart-card figcaption{display:flex;flex-direction:column;margin-bottom:12px}.chart-card figcaption strong{font-size:1rem}.chart-card figcaption span{color:#5b6a80;font-size:.85rem}.quality-cost-plot{display:block;width:100%;height:auto;min-height:250px}.grid-line{stroke:#dbe3ee;stroke-width:1}.axis-line{stroke:#8794a6;stroke-width:1.2}.axis-label,.tick-label,.point-label{fill:#52627a;font:12px ui-sans-serif,system-ui,sans-serif}.point-label{fill:#172033;font-weight:700}.point-pass{stroke-width:2}.point-skill{fill:var(--skill);stroke:var(--skill)}.point-baseline{fill:var(--baseline);stroke:var(--baseline)}.point-prompt{fill:var(--prompt);stroke:var(--prompt)}.point-other{fill:var(--other);stroke:var(--other)}.point-fail{fill:#fff;stroke-width:3}.chart-key{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px;font-size:.82rem;color:#52627a}.key-mark{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:50%;vertical-align:-1px}.key-mark.skill{background:var(--skill)}.key-mark.baseline{background:var(--baseline)}.key-mark.prompt{background:var(--prompt)}
.bar-list{display:grid;gap:10px}.bar-row{display:grid;grid-template-columns:minmax(130px,1.4fr) minmax(120px,2fr) auto;gap:10px;align-items:center}.bar-label{min-width:0}.bar-label strong,.bar-label small{display:block;overflow-wrap:anywhere}.bar-label small{color:#65748a}.bar-track{height:12px;border-radius:999px;background:#e9eef5;overflow:hidden}.bar-fill{display:block;height:100%;min-width:0;border-radius:inherit;background:var(--other)}.bar-fill.arm-skill{background:var(--skill)}.bar-fill.arm-baseline{background:var(--baseline)}.bar-fill.arm-prompt{background:var(--prompt)}.bar-value{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
.table-scroll{overflow-x:auto;border-radius:12px}table{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden}th,td{padding:10px 12px;border-bottom:1px solid #e6ebf2;text-align:left;vertical-align:top}thead th{background:#eef3f9}tbody tr:last-child>*{border-bottom:0}tbody tr:nth-child(even){background:#fafcff}
.wrap{overflow-wrap:anywhere}.status-pass{font-weight:700;color:#17633a}.status-fail{font-weight:700;color:#a3261d}.status-inconclusive{font-weight:700;color:#7a4d00}.number{font-variant-numeric:tabular-nums;white-space:nowrap}
details{margin:10px 0}details>summary{cursor:pointer;font-weight:700}details>summary:focus-visible,a:focus-visible{outline:3px solid #7da3f3;outline-offset:3px}.technical{padding:14px 16px}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.row-details{min-width:80px}.row-details p{min-width:320px;margin:.5rem 0}.proof{border-top:1px solid #e6ebf2;padding:12px 0}.proof:first-of-type{border-top:0}.setup-badge,.best-badge,.gate{display:inline-block;border-radius:999px;padding:2px 8px;font-size:.74rem;font-weight:800;letter-spacing:.02em}.setup-badge{color:#fff;background:var(--other)}.setup-skill{background:var(--skill)}.setup-baseline{background:var(--baseline)}.setup-prompt{background:var(--prompt)}.best-badge{margin-left:6px;color:#16492f;background:#dff4e8}.gate{display:block;width:max-content;margin-top:4px;padding-left:0;background:transparent}
@media(max-width:800px){body{padding:16px}.summary-grid,.detail-grid,.charts-grid{grid-template-columns:1fr 1fr}.table-scroll{margin:0 -8px}.cost-basis{grid-template-columns:1fr}}@media(max-width:620px){.summary-grid,.detail-grid,.charts-grid{grid-template-columns:1fr}.bar-row{grid-template-columns:1fr auto}.bar-track{grid-column:1/-1;grid-row:2}.chart-card-wide{grid-column:auto}}
</style>
</head>
<body>
<h1>Skill Bench Decision Report</h1>
<p class="run-id">Run ${escapeHtml(view.runId)}</p>
<p class="help"><strong>How to read this report:</strong> quality comes from the approved evaluator. A validated winner requires matched evidence and confidence, not just 100% rows. Within each task, passing rows are ordered by lowest known cost. “unknown” means the provider did not expose that value.</p>
<main>
<section aria-label="Decision summary">
<h2>Decision summary</h2>
${confidenceHtml}
${warningsHtml}
<div class="summary-grid">
<div class="metric"><strong>Overall status</strong><span class="status-${escapeHtml(view.decision.state)}">${escapeHtml(view.decision.state)}</span></div>
<div class="metric"><strong>Mode</strong><span>${escapeHtml(view.decision.mode)}</span></div>
<div class="metric"><strong>Matched skill uplift</strong><span>${escapeHtml(formatNullable(view.decision.matchedSkillUplift))}</span></div>
<div class="metric"><strong>Coverage</strong><span>${escapeHtml(view.decision.coverage.scenarioCoverage)}</span></div>
</div>
<p>No winner reason: ${escapeHtml(view.decision.noWinnerReason ?? view.decision.confidence.noWinnerReason ?? "none")}</p>
<p><strong>Recommended route:</strong> ${escapeHtml(view.decision.recommendedRoute ? `${view.decision.recommendedRoute.skillId} with ${view.decision.recommendedRoute.modelId} (${view.decision.recommendedRoute.objective})` : "none — this run does not support an approved routing recommendation")}</p>
<aside class="cost-basis" aria-label="Cost basis"><div><strong>Cost basis</strong><span>${pricingSourceHtml}</span></div><p>${escapeHtml([pricing.currency, pricing.retrievedAt ? `retrieved ${pricing.retrievedAt}` : null, pricing.completeness].filter(Boolean).join(" · "))}</p>${proxyPricing ? `<p class="proxy-note">Public-price proxy; not a GitHub Copilot invoice.</p>` : ""}</aside>
<h3>What to choose per task</h3>
<div class="table-scroll"><table aria-label="Per-task choices">
<thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Cheapest passing</th><th scope="col">Highest quality</th></tr></thead>
<tbody>${view.decision.taskChoices.map((choice) => `<tr><th scope="row" class="wrap">${escapeHtml(choice.taskId)}</th><td class="status-${escapeHtml(choice.state)}">${escapeHtml(choice.state)}</td><td class="wrap">${escapeHtml(formatChoice(choice.cheapestPassing))}</td><td class="wrap">${escapeHtml(formatChoice(choice.highestQuality))}</td></tr>`).join("")}</tbody>
</table></div>
<p><strong>Observed misses across cells:</strong> ${escapeHtml(listOrNone(view.decision.decisiveMisses))}. <strong>False positives:</strong> ${escapeHtml(listOrNone(view.decision.decisiveFalsePositives))}.</p>
<details class="technical"><summary>Full usage and provenance</summary>
<div class="detail-grid">
<p>Budget: spent ${escapeHtml(String(view.budget.spentUsd ?? "unknown"))}, expected ${escapeHtml(String(view.budget.expectedUsd ?? view.budget.estimatedSpentUsd ?? "unknown"))}, max ${escapeHtml(String(view.budget.maxUsd ?? "unknown"))}; premium requests ${escapeHtml(String(view.budget.premiumRequests ?? view.budget.spentPremiumRequests ?? "unknown"))} actual / ${escapeHtml(String(view.budget.estimatedPremiumRequests ?? view.budget.expectedPremiumRequests ?? "unknown"))} expected / ${escapeHtml(String(view.budget.maxPremiumRequests ?? "unknown"))} max</p>
<p>Token/cost completeness: ${escapeHtml(view.tokenCostCompleteness.map((item) => `${item.cellId}:${item.completeness}:${item.provenance}`).join(", "))}</p>
<p>Pricing snapshot: ${escapeHtml([pricing.source, pricing.url, pricing.retrievedAt, pricing.currency, pricing.completeness].filter(Boolean).join(" "))}</p>
<p>Fingerprints: manifest ${escapeHtml(view.provenance.manifestFingerprint)}, evaluation ${escapeHtml(view.provenance.evaluationFingerprint)}, skill ${escapeHtml(view.provenance.skillFingerprint)}, model ${escapeHtml(view.provenance.modelFingerprint)}, environment ${escapeHtml(view.provenance.environmentFingerprint)}</p>
<p>Seed: ${escapeHtml(view.provenance.seed)}</p><p>Exact rerun: ${escapeHtml(view.provenance.rerunCommand)}</p><p>${escapeHtml(browserLine)}</p>
</div></details>
</section>
<section aria-label="Performance charts"><h2>Performance at a glance</h2><p>Direct labels show the task, tested setup, and agent model. Pilot charts describe observed evidence only; they do not authorize routing.</p><div class="charts-grid">${chartsHtml}</div></section>
<section aria-label="Cell comparison"><h2>Cell comparison</h2><p>Rows are grouped by task. Quality-pass rows come first; known costs are ordered lowest first. ${proxyPricing ? "Estimated costs use the visible public-pricing proxy above." : "Costs use the visible run pricing source above."}</p><div class="table-scroll"><table aria-label="Cell comparison"><thead><tr><th scope="col">Task</th><th scope="col">Setup</th><th scope="col">Tested agent (model)</th><th scope="col">Quality</th><th scope="col">${proxyPricing ? "Est. cost USD" : "Cost USD"}</th><th scope="col">Total tokens</th><th scope="col">Latency</th><th scope="col">Details</th></tr></thead><tbody>${comparisonRows}</tbody></table></div></section>
<section aria-label="Proof matrices">
<h2>Proof matrices</h2>
<p>Expand a row to inspect evaluator evidence.</p>${proofHtml}
</section>
</main>
</body>
</html>`;
}

function renderMatrix(matrix: ProofMatrixView): string {
  const rows: Array<[string, string[]]> = [
    ["expected", matrix.expected],
    ["found", matrix.found],
    ["done", matrix.done],
    ["missed", matrix.missed],
    ["false-positive", matrix.falsePositive],
    ["incorrect", matrix.incorrect],
    ["proof", matrix.proof],
  ];
  return `<dl>${rows.map(([key, values]) => `<dt>${escapeHtml(key)}</dt><dd class="wrap">${escapeHtml(listOrNone(values))}</dd>`).join("")}</dl>`;
}

type ReportRow = SkillBenchReportView["rows"][number];

function renderDecisionCharts(rows: ReportRow[]): string {
  const byTask = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const taskRows = byTask.get(row.taskId) ?? [];
    taskRows.push(row);
    byTask.set(row.taskId, taskRows);
  }
  const qualityCostCharts = [...byTask.entries()]
    .map(([taskId, taskRows]) => renderQualityCostChart(taskId, taskRows))
    .join("");
  return `${qualityCostCharts}${renderBarChart(
    "Total tokens",
    "Provider total when available; otherwise input + output. Cache-read tokens are already included in input.",
    "Total tokens chart",
    rows,
    (row) => totalTokenNumber(row.tokens),
    formatInteger,
  )}${renderBarChart(
    "Latency",
    "Wall-clock response time; lower is better.",
    "Latency chart",
    rows,
    (row) => row.latencyMs,
    formatLatency,
  )}`;
}

function renderQualityCostChart(taskId: string, rows: ReportRow[]): string {
  const points = rows.filter(
    (row): row is ReportRow & { costUsd: number } =>
      isFiniteNumber(row.costUsd) && isFiniteNumber(row.qualityScore),
  );
  const chartWidth = 720;
  const chartHeight = 300;
  const left = 64;
  const right = 28;
  const top = 26;
  const bottom = 50;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const maxCost = Math.max(0, ...points.map((row) => row.costUsd));
  const costDomain = maxCost > 0 ? maxCost * 1.08 : 1;
  const yTicks = [0, 0.5, 1]
    .map((tick) => {
      const y = top + (1 - tick) * plotHeight;
      return `<line class="grid-line" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"></line><text class="tick-label" x="${left - 10}" y="${y + 4}" text-anchor="end">${formatQuality(tick)}</text>`;
    })
    .join("");
  const xTicks = [0, 0.5, 1]
    .map((fraction) => {
      const x = left + fraction * plotWidth;
      const anchor = fraction === 0 ? "start" : fraction === 1 ? "end" : "middle";
      return `<line class="grid-line" x1="${x}" y1="${top}" x2="${x}" y2="${top + plotHeight}"></line><text class="tick-label" x="${x}" y="${top + plotHeight + 22}" text-anchor="${anchor}">${escapeHtml(formatUsd(costDomain * fraction))}</text>`;
    })
    .join("");
  const marks = points
    .map((row, index) => {
      const x = left + (row.costUsd / costDomain) * plotWidth;
      const y = top + (1 - clamp(row.qualityScore, 0, 1)) * plotHeight;
      const labelLeft = x > left + plotWidth * 0.72;
      const labelX = x + (labelLeft ? -12 : 12);
      const labelY = y + (index % 2 === 0 ? -10 : 18);
      const title = `${titleCase(row.arm)} / ${row.modelId}: quality ${formatQuality(row.qualityScore)}, estimated cost ${formatUsd(row.costUsd)}, ${row.qualityPassed ? "quality pass" : "quality fail"}`;
      const shape = row.qualityPassed
        ? `<circle cx="${x}" cy="${y}" r="8" class="point-pass point-${armClass(row.arm)}"><title>${escapeHtml(title)}</title></circle>`
        : `<path d="M ${x} ${y - 9} L ${x + 9} ${y} L ${x} ${y + 9} L ${x - 9} ${y} Z" class="point-fail point-${armClass(row.arm)}"><title>${escapeHtml(title)}</title></path>`;
      return `${shape}<text class="point-label" x="${labelX}" y="${labelY}" text-anchor="${labelLeft ? "end" : "start"}">${escapeHtml(`${titleCase(row.arm)} · ${row.modelId}`)}</text>`;
    })
    .join("");
  const exactValues = rows
    .map(
      (row) =>
        `<span><strong>${escapeHtml(`${titleCase(row.arm)} · ${row.modelId}`)}</strong> ${escapeHtml(formatQuality(row.qualityScore))} · ${escapeHtml(formatUsd(row.costUsd))}</span>`,
    )
    .join("");
  const plot = points.length
    ? `<svg class="quality-cost-plot" viewBox="0 0 ${chartWidth} ${chartHeight}" aria-hidden="true" focusable="false">${yTicks}${xTicks}<line class="axis-line" x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}"></line><line class="axis-line" x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}"></line><text class="axis-label" x="${left + plotWidth / 2}" y="${chartHeight - 6}" text-anchor="middle">Estimated cost USD — lower is better</text><text class="axis-label" x="16" y="${top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 16 ${top + plotHeight / 2})">Quality — higher is better</text>${marks}</svg>`
    : `<p>No cells have both quality and known cost, so this plot is unavailable.</p>`;
  return `<figure class="chart-card chart-card-wide" aria-label="Quality versus estimated cost chart"><figcaption><strong>${escapeHtml(taskId)} — quality vs estimated cost</strong><span>Top-left is best: higher approved quality at lower estimated cost. Filled circles pass quality; hollow diamonds fail.</span></figcaption>${plot}<div class="chart-key" aria-label="Exact chart values">${exactValues}</div></figure>`;
}

function renderBarChart(
  title: string,
  description: string,
  ariaLabel: string,
  rows: ReportRow[],
  valueFor: (row: ReportRow) => number | null,
  formatValue: (value: number | null) => string,
): string {
  const values = rows.map(valueFor);
  const max = Math.max(0, ...values.filter(isFiniteNumber));
  const bars = rows
    .map((row, index) => {
      const value = values[index] ?? null;
      const width = isFiniteNumber(value) && max > 0 ? clamp((value / max) * 100, 0, 100) : 0;
      return `<div class="bar-row"><div class="bar-label"><strong>${escapeHtml(`${row.taskId} · ${titleCase(row.arm)}`)}</strong><small>${escapeHtml(row.modelId)}</small></div><div class="bar-track" aria-hidden="true"><span class="bar-fill arm-${armClass(row.arm)}" style="width:${width}%"></span></div><span class="bar-value">${escapeHtml(formatValue(value))}</span></div>`;
    })
    .join("");
  return `<figure class="chart-card" aria-label="${escapeHtml(ariaLabel)}"><figcaption><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></figcaption><div class="bar-list">${bars}</div></figure>`;
}

function winnerBlockReason(mode: SkillBenchRunMode, qualityCellCount: number, cells: ReportCellInput[], confidence: SkillBenchReportView["decision"]["confidence"]): string | null {
  if (mode === "pilot") return "pilot run is not validated evidence";
  if (!hasAnyHardGatePassingCell(cells)) return "no hard-gate passing cell";
  if (!hasAnyQualityPassingCell(cells)) return "no quality-threshold passing cell";
  if (hasCoverageBlockedMatchedPair(cells)) return "matched baseline and skill cells require complete coverage";
  if (qualityCellCount === 0) return "no matched baseline and skill complete parity-valid answer unit";
  if (!hasRequiredConfidenceStatistics(confidence)) return "missing confidence statistics";
  if (confidence.verdict !== "winner") return confidence.noWinnerReason ?? `confidence verdict is ${confidence.verdict}, not winner`;
  if (confidence.interval === null) return "missing confidence interval for winner";
  return null;
}

function normalizeConfidence(mode: SkillBenchRunMode, confidence: ReportConfidenceInput | undefined, matchedUnits: number): SkillBenchReportView["decision"]["confidence"] {
  if (!confidence) return blockedConfidence(mode === "pilot" ? "pilot run is not validated evidence" : "missing confidence statistics");
  const validation = validateConsensusRevision2MetadataFields(confidence.metadata, { matchedUnits });
  const noWinnerReason = validation.ok ? confidence.noWinnerReason : `confidence metadata invalid: ${validation.reason}`;
  return {
    verdict: validation.ok ? confidence.verdict : "inconclusive",
    noWinnerReason,
    familywiseAlpha: confidence.metadata.familywiseAlpha,
    maxLooks: confidence.metadata.maxLooks,
    currentLook: confidence.metadata.currentLook,
    comparisonFamilyId: confidence.metadata.comparisonFamilyId,
    comparisonCount: confidence.metadata.comparisonCount,
    alphaPerComparisonLook: confidence.metadata.alpha,
    lowerQuantile: confidence.metadata.lowerQuantile,
    upperQuantile: confidence.metadata.upperQuantile,
    frozenPairIds: [...confidence.metadata.frozenPairIds],
    resamples: confidence.metadata.resamples,
    seed: confidence.metadata.seed,
    sampleCount: confidence.metadata.sampleCount,
    coverage: confidence.metadata.coverage,
    interval: confidence.interval ? { ...confidence.interval } : null,
  };
}

function blockedConfidence(reason: string): SkillBenchReportView["decision"]["confidence"] {
  return {
    verdict: "inconclusive",
    noWinnerReason: reason,
    familywiseAlpha: 0.05,
    maxLooks: 0,
    currentLook: 0,
    comparisonFamilyId: "unknown",
    comparisonCount: 0,
    alphaPerComparisonLook: 0,
    lowerQuantile: 0,
    upperQuantile: 0,
    frozenPairIds: [],
    resamples: 0,
    seed: "unknown",
    sampleCount: 0,
    coverage: 0,
    interval: null,
  };
}

function hasRequiredConfidenceStatistics(confidence: SkillBenchReportView["decision"]["confidence"]): boolean {
  return (
    confidence.familywiseAlpha === 0.05 &&
    safeNumber(confidence.maxLooks) > 0 &&
    safeNumber(confidence.currentLook) > 0 &&
    safeNumber(confidence.comparisonCount) > 0 &&
    isFiniteNumber(confidence.alphaPerComparisonLook) &&
    confidence.alphaPerComparisonLook > 0 &&
    isFiniteNumber(confidence.lowerQuantile) &&
    isFiniteNumber(confidence.upperQuantile) &&
    confidence.frozenPairIds.length > 0 &&
    safeNumber(confidence.resamples) > 0 &&
    confidence.seed !== "" &&
    safeNumber(confidence.sampleCount) > 0 &&
    safeNumber(confidence.coverage) > 0
  );
}

function taskChoiceRows(
  cells: ReportCellInput[],
): SkillBenchReportView["decision"]["taskChoices"] {
  return unique(cells.map((cell) => cell.taskId))
    .sort()
    .map((taskId) => {
      const taskCells = cells.filter((cell) => cell.taskId === taskId);
      const eligible = eligibleMatchedQualityCells(taskCells);
      const passing = eligible.filter((cell) => qualityGatePassed(cell));
      return {
        taskId,
        state:
          passing.length > 0
            ? "pass"
            : eligible.length > 0
              ? "fail"
              : hasAnyHardGatePassingCell(taskCells)
                ? "inconclusive"
                : "fail",
        cheapestPassing: firstOrNull(
          passing
            .filter((cell) => isFiniteNumber(cell.costUsd))
            .sort(compareCheapest)
            .map(toRanking),
        ),
        highestQuality: firstOrNull(
          [...eligible].sort(compareQuality).map(toRanking),
        ),
      };
    });
}

function computeMatchedSkillUplift(cells: ReportCellInput[]): number | null {
  const matched: number[] = [];
  for (const skillCell of cells.filter((cell) => cell.arm === "skill" && isQualityCell(cell))) {
    const baseline = cells.find((cell) => cell.arm === "baseline" && sameAnswerUnit(cell, skillCell) && isQualityCell(cell));
    if (baseline) matched.push(skillCell.qualityScore - baseline.qualityScore);
  }
  if (matched.length === 0) return null;
  return round(matched.reduce((sum, value) => sum + value, 0) / matched.length);
}

function matchedConfidenceSamples(cells: ReportCellInput[]): number {
  return cells
    .filter(
      (cell) =>
        cell.arm === "skill" &&
        isQualityCell(cell) &&
        cells.some(
          (peer) =>
            peer.arm === "baseline" &&
            sameAnswerUnit(peer, cell) &&
            isQualityCell(peer),
        ),
    )
    .reduce((sum, cell) => sum + safeNumber(cell.samples), 0);
}

function eligibleMatchedQualityCells(cells: ReportCellInput[]): ReportCellInput[] {
  return cells.filter((cell) => isQualityCell(cell) && hasQualityPeer(cell, cells));
}

function hasQualityPeer(cell: ReportCellInput, cells: ReportCellInput[]): boolean {
  const peerArm = peerComparisonArm(cell.arm);
  return peerArm !== null && cells.some((peer) => peer.arm === peerArm && sameAnswerUnit(peer, cell) && isQualityCell(peer));
}

function sameAnswerUnit(a: ReportCellInput, b: ReportCellInput): boolean {
  return a.taskId === b.taskId && a.modelId === b.modelId;
}

function isQualityCell(cell: ReportCellInput): boolean {
  return cell.status === "complete" && cell.hardGatesPassed && isFiniteNumber(cell.qualityScore) && hasRequiredStatistics(cell) && hasRequiredCoverage(cell);
}

function hasRequiredStatistics(cell: ReportCellInput): boolean {
  return safeNumber(cell.samples) > 0 && safeNumber(cell.scenariosRequired) > 0;
}

function hasRequiredCoverage(cell: ReportCellInput): boolean {
  return safeNumber(cell.scenariosCovered) >= safeNumber(cell.scenariosRequired);
}

function hasCoverageBlockedMatchedPair(cells: ReportCellInput[]): boolean {
  return cells.some((cell) => isCompleteParityCell(cell) && !hasRequiredCoverage(cell) && hasCompleteParityPeer(cell, cells));
}

function summarizeScenarioCoverage(cells: ReportCellInput[]): string {
  const maxRequired = Math.max(
    0,
    ...cells.map((cell) => safeNumber(cell.scenariosRequired)),
  );
  if (maxRequired > 1) {
    const covered = cells
      .filter((cell) => cell.arm === "baseline" || cell.arm === "skill")
      .map((cell) => safeNumber(cell.scenariosCovered));
    return `${covered.length > 0 ? Math.min(...covered) : 0}/${maxRequired}`;
  }
  const taskIds = unique(cells.map((cell) => cell.taskId));
  const coveredTasks = taskIds.filter((taskId) => {
    const taskCells = cells.filter((cell) => cell.taskId === taskId);
    return taskCells.some(
      (cell) =>
        (cell.arm === "baseline" || cell.arm === "skill") &&
        isQualityCell(cell) &&
        hasQualityPeer(cell, taskCells),
    );
  });
  return `${coveredTasks.length}/${taskIds.length}`;
}

function hasCompleteParityPeer(cell: ReportCellInput, cells: ReportCellInput[]): boolean {
  const peerArm = peerComparisonArm(cell.arm);
  return peerArm !== null && cells.some((peer) => peer.arm === peerArm && sameAnswerUnit(peer, cell) && isCompleteParityCell(peer));
}

function peerComparisonArm(arm: string): "baseline" | "skill" | null {
  if (arm === "baseline") return "skill";
  if (arm === "skill") return "baseline";
  return null;
}

function isCompleteParityCell(cell: ReportCellInput): boolean {
  return cell.status === "complete" && cell.hardGatesPassed && isFiniteNumber(cell.qualityScore) && hasRequiredStatistics(cell);
}

function hasAnyHardGatePassingCell(cells: ReportCellInput[]): boolean {
  return cells.some((cell) => cell.status === "complete" && cell.hardGatesPassed);
}

function hasAnyQualityPassingCell(cells: ReportCellInput[]): boolean {
  return cells.some(
    (cell) =>
      cell.status === "complete" &&
      cell.hardGatesPassed &&
      qualityGatePassed(cell),
  );
}

function qualityGatePassed(cell: ReportCellInput): boolean {
  return cell.qualityPassed === true;
}

function compareCheapest(a: ReportCellInput, b: ReportCellInput): number {
  return nullableNumber(a.costUsd) - nullableNumber(b.costUsd) || nullableNumber(a.latencyMs) - nullableNumber(b.latencyMs);
}

function compareQuality(a: ReportCellInput, b: ReportCellInput): number {
  return b.qualityScore - a.qualityScore;
}

function toRanking(cell: ReportCellInput): ReportRankingCell {
  return { cellId: cell.id, taskId: cell.taskId, arm: cell.arm, modelId: cell.modelId, qualityScore: cell.qualityScore, costUsd: cell.costUsd, latencyMs: cell.latencyMs };
}

function firstOrNull<T>(items: T[]): T | null {
  return items[0] ?? null;
}

function nullableNumber(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cloneMatrix(matrix: ProofMatrixView): ProofMatrixView {
  return {
    expected: matrix.expected.map(redactPrivatePath),
    found: matrix.found.map(redactPrivatePath),
    done: matrix.done.map(redactPrivatePath),
    missed: matrix.missed.map(redactPrivatePath),
    falsePositive: matrix.falsePositive.map(redactPrivatePath),
    incorrect: matrix.incorrect.map(redactPrivatePath),
    proof: matrix.proof.map(redactPrivatePath),
  };
}

function redactPrivatePath(value: string): string {
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return value;
  const basename = path.win32.isAbsolute(value)
    ? path.win32.basename(value)
    : path.basename(value);
  return `[private-path]/${basename || "redacted"}`;
}

function statusText(cell: ReportCellInput): string {
  if (!cell.hardGatesPassed || cell.status !== "complete")
    return `NOT PASS ${cell.status}`;
  return qualityGatePassed(cell)
    ? "PASS hard gates complete; QUALITY PASS"
    : "PASS hard gates complete; QUALITY FAIL";
}

function listOrNone(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}

function formatNullable(value: number | null): string {
  return value === null ? "unknown" : value.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
}

function formatChoice(choice: ReportRankingCell | null): string {
  if (!choice) return "none";
  return `${choice.modelId} / ${choice.arm}; quality ${formatQuality(choice.qualityScore)}; cost ${formatUsd(choice.costUsd)}`;
}

function formatMetric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function formatToken(tokens: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = tokens[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "unknown";
}

function tokenNumber(tokens: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = tokens[key];
    if (isFiniteNumber(value)) return value;
  }
  return null;
}

function formatTokenCount(tokens: Record<string, unknown>, keys: string[]): string {
  const explicit = tokenNumber(tokens, keys);
  return formatInteger(explicit ?? totalTokenNumber(tokens));
}

function totalTokenNumber(tokens: Record<string, unknown>): number | null {
  const explicit = tokenNumber(tokens, ["total", "totalTokens"]);
  if (explicit !== null) return explicit;
  const input = tokenNumber(tokens, ["input", "inputTokens"]);
  const output = tokenNumber(tokens, ["output", "outputTokens"]);
  return input !== null && output !== null ? input + output : null;
}

function tokenTotalProvenance(tokens: Record<string, unknown>): string {
  const provenance = tokens.totalProvenance;
  if (provenance === "provider-reported") return "provider reported";
  if (provenance === "derived-input-plus-output") return "derived input + output";
  if (typeof provenance === "string" && provenance.trim()) return provenance;
  if (tokenNumber(tokens, ["total", "totalTokens"]) !== null) return "source not reported";
  return totalTokenNumber(tokens) !== null ? "derived input + output for display" : "unknown";
}

function formatInteger(value: number | null): string {
  return isFiniteNumber(value) ? Math.round(value).toLocaleString("en-US") : "unknown";
}

function formatQuality(value: number): string {
  if (!isFiniteNumber(value)) return "unknown";
  if (value < 0 || value > 1) return formatMetric(value);
  const percent = Math.round(value * 1000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

function formatUsd(value: number | null): string {
  if (!isFiniteNumber(value)) return "unknown";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatLatency(value: number | null): string {
  if (!isFiniteNumber(value)) return "unknown";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = Math.round((value / 1000) * 10) / 10;
  return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
}

function titleCase(value: string): string {
  return value
    .replaceAll(/[-_]+/g, " ")
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function armClass(arm: string): "skill" | "baseline" | "prompt" | "other" {
  if (arm === "skill" || arm === "baseline" || arm === "prompt") return arm;
  return "other";
}

function isProxyPricing(source: string): boolean {
  return /public|proxy|api model|estimate/i.test(source);
}

function safeWebUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "unknown";
}

function formatInterval(interval: { lower: number; mean: number; upper: number } | null): string {
  if (!interval) return "none";
  return `${formatNumber(interval.lower)}..${formatNumber(interval.upper)} (mean ${formatNumber(interval.mean)})`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
