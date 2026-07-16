import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  realpathSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildCandidateRequest,
  buildMatchedExecutionCells,
  createProviderWorkspaceRoot,
  currentSkillBenchProviderTransport,
  ensureProviderWorkspace,
  fingerprintSkillDirectory,
  finalizeEvidenceBundle,
  PROVIDER_TRANSPORT_FINGERPRINT,
  REQUIRED_EVIDENCE_ARTIFACTS,
  scheduleCellsWithinCeilings,
  type BudgetStopReason,
  type ExecutionCell,
  type ExecutionProfileConfig,
} from "../skill-bench/execute.js";
import {
  designGateIds,
  freezeReviewedManifestV1,
  validateDesignApprovalLedgerV1,
} from "../skill-bench/design.js";
import {
  renderSkillBenchReportHtml,
  normalizeSkillBenchReport,
  type SkillBenchReportInput,
  type SkillBenchReportView,
} from "../skill-bench/report.js";
import {
  buildRoutingCapabilityProtocolV1,
  parseAdvisoryInstructionRoute,
  planSkillBenchRouteApply,
  preflightSkillBenchExport,
  renderAdvisoryInstructionBlock,
  type RouteRule,
  type RoutingCapabilityEntryV1,
  type RoutingRecommendationV1,
  type RoutingScope,
} from "../skill-bench/routing.js";
import { resolveCopilotPaths } from "../copilot/paths.js";
import { probeModels, type ProbeResult } from "../copilot/models.js";
import { createReviewSpawn } from "../memory-review/spawn.js";
import {
  atomicWriteTrustedFile,
  ensureDir,
  openRegularFile,
  type OpenRegularFileFailureReason,
  writeAllSync,
} from "../utils/fs.js";
import {
  comparePairedDifferences,
  decideValidatedSampling,
  freezeComparisonFamily,
  PROTOCOL_BOOTSTRAP_RESAMPLES,
  PROTOCOL_MINIMUM_MATCHED_UNITS,
} from "../skill-bench/statistics.js";
import {
  estimatePublicTokenCost,
  type PublicModelTokenRates,
  type PublicPricingSnapshot,
} from "../skill-bench/telemetry.js";
import {
  resolveGitHubCopilotPricing,
} from "../skill-bench/pricing.js";
import {
  discoverSkillBenchSkills,
  resolveModelCandidates,
  type DiscoveredSkillBenchSkill,
  type ModelCandidate,
} from "../skill-bench/discovery.js";
import { analyzeHistory } from "../history/analyze.js";
import {
  canonicalJson,
  specContentHash,
  validateEvidenceV1,
  validateRecommendationV1,
  validateRunV1,
  validateSkillBenchSpecV1,
  validateSummaryV1,
  type ValidationResult,
} from "../skill-bench/types.js";
import { runEvaluatorV1, type FrozenEvaluatorDescriptorV1 } from "../skill-bench/evaluate.js";
import {
  resolveSkillBenchPaths,
  resolveSkillBenchOutputPath,
  writeSkillBenchFileAtomic,
  writeSkillBenchJsonAtomic,
  type SkillBenchPaths,
  type SkillBenchScope,
} from "../skill-bench/paths.js";
import type { CliResult, CommandModule } from "./types.js";

const WINDOWS = new Set(["7d", "30d", "90d", "all"]);
const PROJECTS = new Set(["current", "all"]);
const SCOPES = new Set(["project", "user"]);
const EXECUTION_PROFILES = new Set(["restricted", "normal-project", "custom"]);
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HELP =
  "omp skill-bench [<skill-or-path>] [--window <duration>] [--project current|all] [--scope project|user] [--model <id>] [--probe-models] [--judge-model <id>] [--execution-profile restricted|normal-project|custom] [--max-usd <n>] [--max-cells <n>] [--max-runtime-minutes <n>] [--max-premium-requests <n>] [--advanced] [--json] | resume [<draft-id>] [--import <manifest.json>|--approve <gate>|--freeze] | run <spec-id-or-path> --pilot|--validated [--approve-spend] | report <run-id> [--open|--no-open] | rerun <run-id> | apply <run-id> [--scope project|user] [--dry-run] | export <spec-id-or-run-id> --output <path> [--approve]";

type DesignMode = "guided" | "direct";

type ParsedDesign = {
  skillOrPath?: string;
  window: string;
  project: string;
  scope: "project" | "user";
  advanced: boolean;
  probeModels: boolean;
  modelIds: string[];
  judgeModelIds: string[];
  executionProfile: "restricted" | "normal-project" | "custom";
  hardBudgetCeilings: Record<string, number>;
};

type PersistedDesignOutput = Awaited<ReturnType<typeof designOutput>>;

type ArtifactKind = "draft" | "spec" | "run";

type LoadedArtifact = {
  kind: ArtifactKind;
  id: string;
  path: string;
  trustedRoot: string;
  artifact: Record<string, unknown>;
};

type ApprovalStage = "source" | "completed-run" | "applicable-run";

type SkillBenchModelProbe = (modelIds: string[]) => Promise<ProbeResult[]>;

let skillBenchModelProbeForTests: SkillBenchModelProbe | null = null;

export function setSkillBenchModelProbeForTests(
  probe: SkillBenchModelProbe | null,
): void {
  skillBenchModelProbeForTests = probe;
}

async function probeRequestedModels(modelIds: string[]): Promise<ProbeResult[]> {
  if (skillBenchModelProbeForTests)
    return skillBenchModelProbeForTests(modelIds);
  return probeModels(createReviewSpawn(), modelIds, { maxConcurrency: 2 });
}

function fail(message: string): CliResult {
  return { ok: false, exitCode: 1, message };
}

function readRegularFileUtf8(
  filePath: string,
  trustedRoot: string,
):
  | { ok: true; content: string }
  | { ok: false; reason: OpenRegularFileFailureReason } {
  const opened = openRegularFile(filePath, constants.O_RDONLY, {
    rejectHardlinks: true,
    trustedRoot,
  });
  if (!opened.ok) return opened;
  try {
    return { ok: true, content: readFileSync(opened.fd, "utf8") };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    closeSync(opened.fd);
  }
}

function createTextFileIfMissing(
  filePath: string,
  content: () => string,
  trustedRoot: string,
): boolean {
  const existing = openRegularFile(filePath, constants.O_RDONLY, {
    rejectHardlinks: true,
    trustedRoot,
  });
  if (existing.ok) {
    closeSync(existing.fd);
    return false;
  }
  if (existing.reason !== "missing")
    throw new Error(regularFileFailureReason(existing.reason, "file"));
  const text = content();
  atomicWriteTrustedFile(filePath, text, {
    rejectHardlinks: true,
    trustedRoot,
  });
  return true;
}

function writeTrustedFile(
  filePath: string,
  content: string | Buffer,
  trustedRoot: string,
): void {
  atomicWriteTrustedFile(filePath, content, {
    rejectHardlinks: true,
    trustedRoot,
  });
}

function approvalLedgerFailureReason(
  reason: OpenRegularFileFailureReason,
): string {
  return regularFileFailureReason(reason, "approval ledger");
}

function regularFileFailureReason(
  reason: OpenRegularFileFailureReason,
  label: string,
): string {
  if (reason === "missing") return `${label} required`;
  if (reason === "unavailable")
    return `${label} could not be opened safely`;
  return `${label} must be a regular file and remain stable`;
}

function stripCommand(argv: string[]): string[] {
  return argv[0] === "skill-bench" ? argv.slice(1) : argv;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value.`);
  return value;
}

function parseDesign(args: string[]): ParsedDesign {
  let skillOrPath: string | undefined;
  let window = "30d";
  let project = "all";
  let scope: "project" | "user" = "project";
  let advanced = false;
  let probeRequested = false;
  let executionProfile: "restricted" | "normal-project" | "custom" =
    "restricted";
  const modelIds: string[] = [];
  const judgeModelIds: string[] = [];
  const hardBudgetCeilings: Record<string, number> = {};
  const seen = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg === "--advanced") {
      advanced = true;
      continue;
    }
    if (arg === "--probe-models") {
      probeRequested = true;
      continue;
    }
    if (arg === "--window") {
      const value = readValue(args, i, arg);
      if (!WINDOWS.has(value))
        throw new Error("--window accepts: 7d, 30d, 90d, all.");
      if (seen.has(arg) && seen.get(arg) !== value)
        throw new Error("conflicting --window values.");
      seen.set(arg, value);
      window = value;
      i += 1;
      continue;
    }
    if (arg === "--project") {
      const value = readValue(args, i, arg);
      if (!PROJECTS.has(value))
        throw new Error("--project accepts: current, all.");
      if (seen.has(arg) && seen.get(arg) !== value)
        throw new Error("conflicting --project values.");
      seen.set(arg, value);
      project = value;
      i += 1;
      continue;
    }
    if (arg === "--scope") {
      const value = readValue(args, i, arg);
      if (!SCOPES.has(value))
        throw new Error("--scope accepts: project, user.");
      if (seen.has(arg) && seen.get(arg) !== value)
        throw new Error("conflicting --scope values.");
      seen.set(arg, value);
      scope = value as "project" | "user";
      i += 1;
      continue;
    }
    if (arg === "--model" || arg === "--judge-model") {
      const value = readValue(args, i, arg);
      if (!SAFE_MODEL_ID.test(value))
        throw new Error(`${arg} must be a safe model id.`);
      const target = arg === "--model" ? modelIds : judgeModelIds;
      if (!target.includes(value)) target.push(value);
      i += 1;
      continue;
    }
    if (arg === "--execution-profile") {
      const value = readValue(args, i, arg);
      if (!EXECUTION_PROFILES.has(value))
        throw new Error(
          "--execution-profile accepts: restricted, normal-project, custom.",
        );
      if (seen.has(arg) && seen.get(arg) !== value)
        throw new Error("conflicting --execution-profile values.");
      seen.set(arg, value);
      executionProfile = value as "restricted" | "normal-project" | "custom";
      i += 1;
      continue;
    }
    if (
      arg === "--max-usd" ||
      arg === "--max-cells" ||
      arg === "--max-runtime-minutes" ||
      arg === "--max-premium-requests"
    ) {
      const value = readValue(args, i, arg);
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0)
        throw new Error(`${arg} requires a non-negative number.`);
      const key = {
        "--max-usd": "maxUsd",
        "--max-cells": "maxCells",
        "--max-runtime-minutes": "maxRuntimeMinutes",
        "--max-premium-requests": "maxPremiumRequests",
      }[arg];
      if (seen.has(arg) && seen.get(arg) !== value)
        throw new Error(`conflicting ${arg} values.`);
      seen.set(arg, value);
      hardBudgetCeilings[key] = numeric;
      i += 1;
      continue;
    }
    if (arg.startsWith("--"))
      throw new Error(
        `Unexpected skill-bench argument: ${arg}. See: omp skill-bench --help.`,
      );
    if (skillOrPath)
      throw new Error(
        `Unexpected skill-bench argument: ${arg}. See: omp skill-bench --help.`,
      );
    skillOrPath = arg;
  }
  if (probeRequested && modelIds.length === 0)
    throw new Error("--probe-models requires at least one --model.");
  return {
    skillOrPath,
    window,
    project,
    scope,
    advanced,
    probeModels: probeRequested,
    modelIds,
    judgeModelIds,
    executionProfile,
    hardBudgetCeilings,
  };
}

function scopeRoot(cwd: string, scope: "project" | "user"): string {
  const paths = resolveSkillBenchPaths({ cwd });
  const root = scope === "project" ? paths.projectRoot : paths.globalRoot;
  return path.relative(cwd, root) || root;
}

async function designOutput(parsed: ParsedDesign, cwd: string) {
  const mode: DesignMode = parsed.skillOrPath ? "direct" : "guided";
  const scope: SkillBenchScope =
    parsed.scope === "project" ? "project" : "global";
  const paths = resolveSkillBenchPaths({ cwd });
  const root = scope === "project" ? paths.projectRoot : paths.globalRoot;
  const discovery = discoverDesignSkills(parsed, cwd);
  const selection = selectDesignSkills(parsed, mode, discovery.skills, cwd);
  const probeTargets = [...new Set(parsed.modelIds)];
  const probeResults = parsed.probeModels
    ? await probeRequestedModels(probeTargets)
    : [];
  const probeByModel = new Map(
    probeResults.map((result) => [result.model, result.status]),
  );
  const modelResolution = await resolveModelCandidates({
    historyObservedIds:
      parsed.modelIds.length === 0 ? historyObservedModelIds() : [],
    configuredIds: configuredModelIds(cwd),
    hostDefaultIds: ["auto"],
    explicitIds: parsed.modelIds,
    providerSnapshots: configuredProviderSnapshots(cwd),
    probe: parsed.probeModels
      ? async (id) => ({ status: probeByModel.get(id) ?? "unknown" })
      : undefined,
  });
  const unavailableExplicit = parsed.modelIds.filter(
    (id) =>
      configuredUnavailableModelIds(cwd).includes(id) ||
      probeByModel.get(id) === "unavailable",
  );
  if (unavailableExplicit.length > 0)
    throw new Error(`Explicit skill-bench model is unavailable: ${unavailableExplicit.join(", ")}.`);
  const selectedModelIds = modelResolution.candidates
    .filter((candidate) =>
      parsed.modelIds.includes(candidate.id) && candidate.selectable,
    )
    .map((candidate) => candidate.id);
  const identityInput = {
    mode,
    skillOrPath: parsed.skillOrPath ?? null,
    selectedSkills: selection.selected.map((skill) => ({
      id: skill.id,
      canonicalPath: skill.canonicalPath,
      fingerprint: skill.fingerprint,
    })),
    window: parsed.window,
    project: parsed.project,
    scope: parsed.scope,
    advanced: parsed.advanced,
    probeModels: parsed.probeModels,
    modelIds: parsed.modelIds,
    judgeModelIds: parsed.judgeModelIds,
    executionProfile: parsed.executionProfile,
    hardBudgetCeilings: parsed.hardBudgetCeilings,
  };
  const id = `${mode}-${stableId(identityInput)}`;
  const draftPath = path.join(root, "drafts", id, "design.json");
  return {
    schemaVersion: 1,
    id,
    phase: "design",
    mode,
    skillOrPath: parsed.skillOrPath,
    filters: { window: parsed.window, project: parsed.project },
    skills: {
      selected: selection.selected.map(serializeDiscoveredSkill),
      candidates: selection.candidates.map(serializeDiscoveredSkill),
      duplicates: selection.duplicates.map((group) => ({
        name: group.name,
        candidates: group.candidates.map(serializeDiscoveredSkill),
      })),
      rejected: discovery.rejected,
      provenance: selection.provenance,
    },
    models: {
      candidateModelIds: modelResolution.candidates.map((candidate) => candidate.id),
      selectedModelIds,
      judgeModelIds: parsed.judgeModelIds,
      candidates: modelResolution.candidates.map(serializeModelCandidate),
      provenance: modelResolution.enumerationProvenance,
      completeEnumeration: modelResolution.completeEnumeration,
      probeRequested: parsed.probeModels,
      probeTargets,
      probeProvenance: parsed.probeModels
        ? "explicit opt-in provider probes for requested model ids only"
        : "not probed; unknown remains selectable",
    },
    executionProfile: parsed.executionProfile,
    hardBudgetCeilings: parsed.hardBudgetCeilings,
    scope: parsed.scope,
    advanced: parsed.advanced,
    approvals: {
      selection: false,
      reference: false,
      frozen: false,
      budget: false,
      liveCellsAllowed: false,
    },
    gates: { freezeRequiredBeforeRun: true, nonTtyAutoApproval: false },
    draftPath,
    next:
      mode === "guided"
        ? {
            action: "select-skill-identity",
            candidateCount: selection.candidates.length,
            command: "omp skill-bench <skill-identity-or-path> --json",
            resumeCommand: `omp skill-bench resume ${id}`,
          }
        : {
            action: "continue-pair-design",
            command: `omp skill-bench resume ${id}`,
          },
  };
}

function designSkillRoots(cwd: string): {
  projectRoots: string[];
  userRoots: string[];
  pluginRoots: string[];
} {
  const home = process.env.HOME ?? homedir();
  return {
    projectRoots: [path.join(cwd, ".github", "skills")],
    userRoots: [path.join(home, ".copilot", "skills")],
    pluginRoots: installedPluginSkillRoots(cwd, home),
  };
}

function installedPluginSkillRoots(cwd: string, home: string): string[] {
  const roots = new Set<string>();
  const pluginRoots = [
    process.env.COPILOT_PLUGIN_ROOT,
    process.env.OMP_PLUGIN_ROOT,
    path.join(cwd, ".copilot", "installed-plugins"),
    path.join(home, ".copilot", "installed-plugins"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const pluginRoot of pluginRoots) {
    const candidates = [pluginRoot];
    try {
      if (existsSync(pluginRoot)) {
        for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
          if (entry.isDirectory()) candidates.push(path.join(pluginRoot, entry.name));
        }
      }
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      for (const root of [
        path.join(candidate, ".github", "skills"),
        path.join(candidate, "skills"),
      ]) {
        if (existsSync(root)) roots.add(root);
      }
    }
  }
  return [...roots].sort();
}

function discoverDesignSkills(parsed: ParsedDesign, cwd: string) {
  const roots = designSkillRoots(cwd);
  const explicitPaths =
    parsed.skillOrPath && looksLikePathTarget(parsed.skillOrPath)
      ? [path.resolve(cwd, parsed.skillOrPath)]
      : [];
  return discoverSkillBenchSkills({ ...roots, explicitPaths });
}

function selectDesignSkills(
  parsed: ParsedDesign,
  mode: DesignMode,
  discovered: DiscoveredSkillBenchSkill[],
  cwd: string,
): {
  selected: DiscoveredSkillBenchSkill[];
  candidates: DiscoveredSkillBenchSkill[];
  duplicates: Array<{
    name: string;
    candidates: DiscoveredSkillBenchSkill[];
  }>;
  provenance: string[];
} {
  if (mode === "direct") {
    const target = parsed.skillOrPath ?? "";
    const matches = looksLikePathTarget(target)
      ? discovered.filter((skill) => skill.sourceKind === "explicit")
      : discovered.filter((skill) => skillMatchesTarget(skill, target));
    if (matches.length === 0)
      throw new Error(
        `Direct skill-bench target did not resolve to an installed skill: ${target}.`,
      );
    const distinct = uniqueSkills(matches);
    if (distinct.length > 1)
      throw new Error(
        `Direct skill-bench target is ambiguous: ${target} matched ${distinct.map((skill) => `${skill.name} (${skill.canonicalPath})`).join(", ")}.`,
      );
    return {
      selected: distinct,
      candidates: distinct,
      duplicates: [],
      provenance: [
        looksLikePathTarget(target)
          ? "explicit path resolved through skill discovery"
          : "explicit skill id/name resolved through installed skill discovery",
      ],
    };
  }

  const rankedSkillNames = (() => {
    try {
      return analyzeHistory({
        window: parsed.window as "7d" | "30d" | "90d" | "all",
        project: parsed.project as "current" | "all",
        cwd,
      }).skills.map((row) => row.skill);
    } catch {
      return [];
    }
  })();
  const byRank = new Map(rankedSkillNames.map((skill, index) => [skill, index]));
  const candidates = [...discovered].sort((left, right) => {
    const leftRank = byRank.get(skillSlug(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = byRank.get(skillSlug(right)) ?? Number.MAX_SAFE_INTEGER;
    return (
      leftRank - rightRank ||
      left.name.localeCompare(right.name) ||
      left.canonicalPath.localeCompare(right.canonicalPath)
    );
  });
  return {
    selected: [],
    candidates,
    duplicates: duplicateGuidedCandidateGroups(candidates),
    provenance: [
      "installed skill discovery",
      "history invocation ranking when session-state is available",
    ],
  };
}

function duplicateGuidedCandidateGroups(
  candidates: DiscoveredSkillBenchSkill[],
): Array<{ name: string; candidates: DiscoveredSkillBenchSkill[] }> {
  const byTarget = new Map<string, DiscoveredSkillBenchSkill[]>();
  for (const skill of candidates) {
    for (const target of [skill.name.toLowerCase(), skillSlug(skill).toLowerCase()]) {
      const bucket = byTarget.get(target) ?? [];
      bucket.push(skill);
      byTarget.set(target, bucket);
    }
  }
  const groups = new Map<
    string,
    { name: string; candidates: DiscoveredSkillBenchSkill[] }
  >();
  for (const [target, skills] of byTarget) {
    const distinct = uniqueSkills(skills);
    if (distinct.length <= 1) continue;
    const signature = distinct
      .map((skill) => skill.canonicalPath)
      .sort()
      .join("\0");
    if (!groups.has(signature)) {
      groups.set(signature, { name: target, candidates: distinct });
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function readRawConfig(cwd: string): Record<string, unknown> {
  const home = process.env.HOME ?? homedir();
  const files = [
    path.join(home, ".omp", "config.json"),
    path.join(cwd, ".omp", "config.json"),
  ];
  return files.reduce<Record<string, unknown>>((acc, filePath) => {
    try {
      if (!existsSync(filePath)) return acc;
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return isRecord(parsed) ? { ...acc, ...parsed } : acc;
    } catch {
      return acc;
    }
  }, {});
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function configuredModelIds(cwd: string): string[] {
  const raw = readRawConfig(cwd);
  return uniqueStrings([
    ...stringList(raw.memoryReviewModel),
    ...stringList(raw.model),
    ...stringList(raw.models),
    ...stringList(raw.skillBenchModelCandidates),
    ...stringList(raw.skillBenchModels),
  ]);
}

function configuredProviderSnapshots(cwd: string) {
  const raw = readRawConfig(cwd);
  const snapshots = Array.isArray(raw.skillBenchProviderSnapshots)
    ? raw.skillBenchProviderSnapshots
    : [];
  return snapshots.filter(isRecord).flatMap((snapshot) => {
    const url = typeof snapshot.url === "string" ? snapshot.url : null;
    const date = typeof snapshot.date === "string" ? snapshot.date : null;
    const modelIds = stringList(snapshot.modelIds);
    return url && date && modelIds.length > 0 ? [{ url, date, modelIds }] : [];
  });
}

function configuredUnavailableModelIds(cwd: string): string[] {
  const raw = readRawConfig(cwd);
  return uniqueStrings([
    ...stringList(raw.skillBenchUnavailableModels),
    ...stringList(raw.unavailableModels),
  ]);
}

const HISTORY_MODEL_MAX_FILES = 256;
const HISTORY_MODEL_MAX_DIRECTORY_ENTRIES = 1_024;
const HISTORY_MODEL_EDGE_BYTES = 32 * 1024;

function readHistoryModelSample(fd: number): string {
  const size = fstatSync(fd).size;
  const headLength = Math.min(size, HISTORY_MODEL_EDGE_BYTES);
  const tailStart = Math.max(headLength, size - HISTORY_MODEL_EDGE_BYTES);
  const chunks: string[] = [];
  for (const [position, length] of [
    [0, headLength],
    [tailStart, size - tailStart],
  ] as const) {
    if (length <= 0) continue;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    chunks.push(buffer.subarray(0, bytesRead).toString("utf8"));
  }
  return chunks.join("\n");
}

function historyObservedModelIds(): string[] {
  const root = path.join(process.env.HOME ?? homedir(), ".copilot", "session-state");
  const ids: string[] = [];
  try {
    if (!lstatSync(root).isDirectory()) return [];
    const eventFiles: Array<{ filePath: string; mtimeMs: number }> = [];
    const directory = opendirSync(root);
    try {
      for (
        let visited = 0;
        visited < HISTORY_MODEL_MAX_DIRECTORY_ENTRIES;
        visited += 1
      ) {
        const session = directory.readSync();
        if (!session) break;
        if (!session.isDirectory()) continue;
        const filePath = path.join(root, session.name, "events.jsonl");
        try {
          const stats = lstatSync(filePath);
          if (stats.isFile())
            eventFiles.push({ filePath, mtimeMs: stats.mtimeMs });
        } catch {
          // Optional history hints skip unreadable session entries.
        }
      }
    } finally {
      directory.closeSync();
    }
    eventFiles.sort(
      (left, right) =>
        right.mtimeMs - left.mtimeMs ||
        left.filePath.localeCompare(right.filePath),
    );
    for (const { filePath } of eventFiles.slice(0, HISTORY_MODEL_MAX_FILES)) {
      const opened = openRegularFile(filePath, constants.O_RDONLY, {
        rejectHardlinks: true,
        trustedRoot: root,
      });
      if (!opened.ok) continue;
      let sample: string;
      try {
        sample = readHistoryModelSample(opened.fd);
      } finally {
        closeSync(opened.fd);
      }
      for (const line of sample.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const data = isRecord(parsed?.data) ? parsed.data : {};
          const usage = isRecord(data.usage) ? data.usage : {};
          for (const value of [
            data.currentModel,
            data.model,
            usage.currentModel,
            usage.model,
          ]) {
            if (typeof value === "string" && SAFE_MODEL_ID.test(value)) ids.push(value);
          }
        } catch {
          // History model hints are optional provenance; ignore malformed lines.
        }
      }
    }
  } catch {
    return [];
  }
  return uniqueStrings(ids);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueSkills(skills: DiscoveredSkillBenchSkill[]): DiscoveredSkillBenchSkill[] {
  const seen = new Set<string>();
  const unique: DiscoveredSkillBenchSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.canonicalPath)) continue;
    seen.add(skill.canonicalPath);
    unique.push(skill);
  }
  return unique;
}

function skillSlug(skill: DiscoveredSkillBenchSkill): string {
  return path.basename(skill.canonicalPath);
}

function skillMatchesTarget(skill: DiscoveredSkillBenchSkill, target: string): boolean {
  const normalized = target.toLowerCase();
  return (
    skill.id === target ||
    skill.name.toLowerCase() === normalized ||
    skillSlug(skill).toLowerCase() === normalized
  );
}

function serializeDiscoveredSkill(skill: DiscoveredSkillBenchSkill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    canonicalPath: skill.canonicalPath,
    skillFilePath: skill.skillFilePath,
    sourceUri: skill.sourceUri,
    sourceKind: skill.sourceKind,
    fingerprint: skill.fingerprint,
    provenance: skill.provenance,
  };
}

function serializeModelCandidate(candidate: ModelCandidate) {
  return {
    id: candidate.id,
    sources: candidate.sources,
    probeStatus: candidate.probeStatus,
    selectable: candidate.selectable,
    unavailableReason: candidate.unavailableReason,
  };
}

function stableId(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 12);
}

function persistDesign(
  output: PersistedDesignOutput,
  cwd: string,
): PersistedDesignOutput {
  const scope: SkillBenchScope =
    output.scope === "project" ? "project" : "global";
  const paths = resolveSkillBenchPaths({ cwd });
  const relative = path.posix.join("drafts", output.id, "design.json");
  const persistedPath = writeSkillBenchJsonAtomic(
    paths,
    scope,
    relative,
    output,
  );
  const root = scope === "project" ? paths.projectRoot : paths.globalRoot;
  const approvalsPath = path.join(root, "drafts", output.id, "approvals.jsonl");
  mkdirSync(path.dirname(approvalsPath), { recursive: true });
  createTextFileIfMissing(
    approvalsPath,
    () =>
      `${canonicalJson({ schemaVersion: 1, draftId: output.id, stage: "created", approved: false, source: "omp skill-bench", artifactPath: persistedPath })}\n`,
    path.dirname(path.dirname(root)),
  );
  return { ...output, draftPath: persistedPath };
}

function formatDesign(output: PersistedDesignOutput, cwd: string): string {
  const label = output.mode === "direct" ? "Direct" : "Guided";
  const selection =
    output.mode === "direct"
      ? `skill=${output.skillOrPath}`
      : `history window=${output.filters.window} project=${output.filters.project}`;
  const root = scopeRoot(cwd, output.scope);
  const draftPath = path.relative(cwd, output.draftPath) || output.draftPath;
  const models =
    output.models.selectedModelIds.length > 0
      ? `\nmodels=${output.models.selectedModelIds.join(",")} judges=${output.models.judgeModelIds.join(",") || "none"} probes=${output.models.probeRequested ? "explicit-opt-in" : "not-run"}`
      : "";
  const budgets =
    Object.keys(output.hardBudgetCeilings).length > 0
      ? ` hard-budget=${JSON.stringify(output.hardBudgetCeilings)}`
      : "";
  const continuation =
    "resumeCommand" in output.next
      ? `next: ${output.next.command}\nresume: ${output.next.resumeCommand}`
      : `resume: ${output.next.command}`;
  return `${label} skill-bench draft saved\ndraft-id=${output.id}\ndraft-path=${draftPath}\n${selection}\nexecution-profile=${output.executionProfile}${budgets}${models}\nscope=${output.scope} root=${root}\napprovals: freeze=false budget=false live-cells=blocked\n${continuation}`;
}

function requireId(args: string[], usage: string): string | CliResult {
  const id = args[1];
  if (!id || id.startsWith("--"))
    return fail(`Missing skill-bench id. Usage: ${usage}.`);
  return id;
}

function rejectStray(
  args: string[],
  allowedFlags: Set<string>,
  startIndex: number,
): CliResult | undefined {
  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (allowedFlags.has(arg)) continue;
    return fail(
      `Unexpected skill-bench argument: ${arg}. See: omp skill-bench --help.`,
    );
  }
  return undefined;
}

function rejectResumeStray(
  args: string[],
  allowedFlags: Set<string>,
  startIndex: number,
): CliResult | undefined {
  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (allowedFlags.has(arg)) {
      if (arg === "--freeze") continue;
      i += 1;
      continue;
    }
    return fail(`Unexpected skill-bench argument: ${arg}. See: omp skill-bench --help.`);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const child = value[key];
  return isRecord(child) ? child : {};
}

function loadJsonFile(filePath: string, trustedRoot: string): unknown {
  const loaded = readRegularFileUtf8(filePath, trustedRoot);
  if (!loaded.ok)
    throw new Error(regularFileFailureReason(loaded.reason, "JSON file"));
  return JSON.parse(loaded.content) as unknown;
}

function safeArtifactId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

function validateApprovedArtifact(
  id: string,
  artifact: unknown,
  options: { stage?: ApprovalStage; artifactPath?: string; trustedRoot?: string } = {},
): CliResult | undefined {
  if (!isRecord(artifact))
    return fail(
      `Skill-bench artifact ${id} is not approved: artifact is invalid.`,
    );
  if (typeof artifact.id === "string" && artifact.id !== id)
    return fail(
      `Skill-bench artifact ${id} is not approved: artifact id mismatch.`,
    );
  if (
    (options.stage === "completed-run" || options.stage === "applicable-run") &&
    artifact.status !== "completed" &&
    artifact.status !== "complete"
  )
    return fail(
      `Skill-bench artifact ${id} is not approved: run is not completed.`,
    );

  const approvals = nestedRecord(artifact, "approvals");
  if (options.stage === "source" && artifact.status !== "frozen")
    return fail(
      `Skill-bench artifact ${id} is not approved: frozen spec status required.`,
    );
  if (approvals.frozen !== true)
    return fail(
      `Skill-bench artifact ${id} is not approved: frozen approval required.`,
    );
  if (approvals.budget !== true)
    return fail(
      `Skill-bench artifact ${id} is not approved: budget approval required.`,
    );

  const fingerprint = nestedRecord(artifact, "fingerprint");
  if (fingerprint.status !== "current")
    return fail(
      `Skill-bench artifact ${id} is not approved: fingerprint is stale.`,
    );

  if (options.stage === "source") {
    const ledgerFailure = validateApprovalLedger(
      id,
      artifact,
      options.artifactPath,
      options.trustedRoot,
    );
    if (ledgerFailure) return ledgerFailure;
  }

  if (options.stage === "source") return undefined;

  if (options.stage === "completed-run" || options.stage === "applicable-run") {
    const ledgerFailure = validateRunSourceApprovalLedger(
      id,
      artifact,
      options.artifactPath,
      options.trustedRoot,
    );
    if (ledgerFailure) return ledgerFailure;
  }

  if (options.stage === "applicable-run" && approvals.liveCellsAllowed !== true)
    return fail(
      `Skill-bench artifact ${id} is not approved: live-cell approval required.`,
    );

  if (options.stage === "applicable-run") {
    const recommendation = nestedRecord(artifact, "recommendation");
    const confidence = nestedRecord(recommendation, "confidence");
    const hasValidatedRecommendation =
      recommendation.valid === true ||
      recommendation.validated === true ||
      (typeof recommendation.humanApprovedPolicy === "string" &&
        ["tie", "inconclusive"].includes(String(confidence.verdict)));
    if (!hasValidatedRecommendation)
      return fail(
        `Skill-bench artifact ${id} is not approved: recommendation is not valid.`,
      );
  }

  const conflicts = nestedRecord(artifact, "conflicts");
  if (conflicts.status !== "clear")
    return fail(
      `Skill-bench artifact ${id} is not approved: conflicts are not clear.`,
    );

  const evidence = nestedRecord(artifact, "evidence");
  if (evidence.status !== "verified")
    return fail(
      `Skill-bench artifact ${id} is not approved: evidence is not verified.`,
    );

  return undefined;
}

function validateApprovalLedger(
  id: string,
  artifact: Record<string, unknown>,
  artifactPath: string | undefined,
  trustedRoot: string | undefined,
): CliResult | undefined {
  if (!artifactPath || !trustedRoot)
    return fail(`Skill-bench artifact ${id} is not approved: approval ledger required.`);
  const ledgerPath = path.join(path.dirname(artifactPath), "approvals.jsonl");
  const ledger = readRegularFileUtf8(ledgerPath, trustedRoot);
  if (!ledger.ok)
    return fail(
      `Skill-bench artifact ${id} is not approved: ${approvalLedgerFailureReason(ledger.reason)}.`,
    );
  try {
    const validation = resolveApprovalLedgerBinding(
      artifact,
      ledger.content,
      true,
    );
    if (!validation.ok)
      return fail(
        `Skill-bench artifact ${id} is not approved: ${validation.reason}.`,
      );
  } catch {
    return fail(`Skill-bench artifact ${id} is not approved: approval ledger is invalid.`);
  }
  return undefined;
}

function approvalHashCandidates(
  artifact: Record<string, unknown>,
): string[] {
  const currentHash = specContentHash(artifact);
  const fingerprint = nestedRecord(artifact, "fingerprint");
  if (artifact.status !== "frozen" || fingerprint.status !== "current") {
    return [currentHash];
  }

  const { status: _status, ...approvedFingerprint } = fingerprint;
  const approvedArtifact = { ...artifact };
  if (Object.keys(approvedFingerprint).length === 0) {
    delete approvedArtifact.fingerprint;
  } else {
    approvedArtifact.fingerprint = approvedFingerprint;
  }
  const approvedHash = specContentHash(approvedArtifact);
  return approvedHash === currentHash
    ? [currentHash]
    : [currentHash, approvedHash];
}

function resolveApprovalLedgerBinding(
  artifact: Record<string, unknown>,
  ledger: string,
  requireFreeze: boolean,
):
  | { ok: true; specContentHash: string }
  | { ok: false; reason: string } {
  let currentFailure: string | undefined;
  for (const candidate of approvalHashCandidates(artifact)) {
    const validation = validateDesignApprovalLedgerV1(ledger, candidate, {
      requireFreeze,
    });
    if (validation.ok) return { ok: true, specContentHash: candidate };
    currentFailure ??= validation.reason;
  }
  return {
    ok: false,
    reason: currentFailure ?? "approval ledger does not match the frozen spec",
  };
}

function recordLiveSpendApproval(source: LoadedArtifact): CliResult | undefined {
  const ledgerPath = path.join(path.dirname(source.path), "approvals.jsonl");
  const opened = openRegularFile(
    ledgerPath,
    constants.O_RDWR | constants.O_APPEND,
    { rejectHardlinks: true, trustedRoot: source.trustedRoot },
  );
  if (!opened.ok)
    return fail(
      `Skill-bench artifact ${source.id} is not approved: ${approvalLedgerFailureReason(opened.reason)} before spend.`,
    );
  try {
    const specHash = specContentHash(source.artifact);
    const current = currentSpendApproval(
      readFileSync(opened.fd, "utf8"),
      specHash,
    );
    if (!current.ok)
      return fail(`Skill-bench artifact ${source.id} spend approval ledger is invalid: ${current.reason}.`);
    if (!current.approved) {
      writeAllSync(
        opened.fd,
        `${JSON.stringify({
          schemaVersion: 1,
          type: "spend-approval",
          approved: true,
          specContentHash: specHash,
          approvedAt: new Date().toISOString(),
        })}\n`,
      );
      fsyncSync(opened.fd);
    }
  } catch {
    return fail(
      `Skill-bench artifact ${source.id} spend approval ledger could not be updated safely.`,
    );
  } finally {
    closeSync(opened.fd);
  }
  return undefined;
}

function liveSpendApprovalStatus(
  source: LoadedArtifact,
): { ok: true; approved: boolean } | CliResult {
  const ledgerPath = path.join(path.dirname(source.path), "approvals.jsonl");
  const ledger = readRegularFileUtf8(ledgerPath, source.trustedRoot);
  if (!ledger.ok)
    return fail(
      `Skill-bench ${source.id} live-cell approval failed: ${approvalLedgerFailureReason(ledger.reason)}.`,
    );
  const current = currentSpendApproval(
    ledger.content,
    specContentHash(source.artifact),
  );
  if (!current.ok)
    return fail(`Skill-bench ${source.id} spend approval ledger is invalid: ${current.reason}.`);
  return current;
}

function validateLiveSpendApproval(source: LoadedArtifact): CliResult | undefined {
  const current = liveSpendApprovalStatus(source);
  if (isCliFailure(current)) return current;
  return current.approved
    ? undefined
    : fail(`Skill-bench ${source.id} live-cell approval is not bound to the frozen spec.`);
}

function currentSpendApproval(
  ledger: string,
  expectedSpecHash: string,
): { ok: true; approved: boolean } | { ok: false; reason: string } {
  let matches = 0;
  try {
    for (const line of ledger.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event) || event.type !== "spend-approval") continue;
      if (event.specContentHash !== expectedSpecHash) continue;
      if (event.approved !== true)
        return { ok: false, reason: "current spend approval is not affirmative" };
      matches += 1;
    }
  } catch {
    return { ok: false, reason: "invalid JSONL" };
  }
  if (matches > 1)
    return { ok: false, reason: "duplicate current spend approvals" };
  return { ok: true, approved: matches === 1 };
}

function validateRunSourceApprovalLedger(
  id: string,
  artifact: Record<string, unknown>,
  artifactPath: string | undefined,
  trustedRoot: string | undefined,
): CliResult | undefined {
  const binding = nestedRecord(artifact, "sourceApproval");
  if (
    typeof binding.specContentHash !== "string" ||
    typeof binding.ledgerSha256 !== "string" ||
    !artifactPath ||
    !trustedRoot
  ) {
    return fail(
      `Skill-bench run ${id} is not approved: source approval binding required.`,
    );
  }
  const ledgerPath = path.join(path.dirname(artifactPath), "approvals.jsonl");
  const ledgerFile = readRegularFileUtf8(ledgerPath, trustedRoot);
  if (!ledgerFile.ok)
    return fail(
      `Skill-bench run ${id} is not approved: ${approvalLedgerFailureReason(ledgerFile.reason)}.`,
    );
  const ledger = ledgerFile.content;
  if (sha256Text(ledger) !== binding.ledgerSha256)
    return fail(
      `Skill-bench run ${id} is not approved: approval ledger hash mismatch.`,
    );
  const validation = validateDesignApprovalLedgerV1(
    ledger,
    binding.specContentHash,
    { requireFreeze: true },
  );
  return validation.ok
    ? undefined
    : fail(`Skill-bench run ${id} is not approved: ${validation.reason}.`);
}

function validatePublicArtifactShape(
  id: string,
  artifact: Record<string, unknown>,
  kind: "spec" | "run",
): CliResult | undefined {
  const validation =
    kind === "spec" ? validateSkillBenchSpecV1(artifact) : validateRunV1(normalizeRunForV1Validation(artifact));
  const failure = validationFailure(id, kind, validation);
  if (failure) return failure;
  if (kind === "run") {
    if (artifact.status !== "completed" && artifact.status !== "complete")
      return fail(`Skill-bench run ${id} is malformed: status must be complete.`);
    if (typeof artifact.mode !== "string")
      return fail(`Skill-bench run ${id} is malformed: missing mode.`);
    const evidence = nestedRecord(artifact, "evidence");
    if (evidence.schemaVersion === 1) {
      const evidenceFailure = validationFailure(id, "evidence", validateEvidenceV1(evidence));
      if (evidenceFailure) return evidenceFailure;
    } else if (typeof evidence.status !== "string") {
      return fail(`Skill-bench run ${id} is malformed: missing evidence status.`);
    }
    const summary = nestedRecord(artifact, "summary");
    if (summary.schemaVersion === 1) {
      const summaryFailure = validationFailure(id, "summary", validateSummaryV1(summary));
      if (summaryFailure) return summaryFailure;
    }
    const recommendation = artifact.recommendation;
    if (recommendation !== undefined) {
      const recommendationFailure = validationFailure(
        id,
        "recommendation",
        validateRecommendationV1(recommendation),
      );
      if (recommendationFailure) return recommendationFailure;
    }
  }
  return undefined;
}

function normalizeRunForV1Validation(
  artifact: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...artifact,
    status: artifact.status === "completed" ? "complete" : artifact.status,
    specId: artifact.specId ?? artifact.sourceId,
    cells: Array.isArray(artifact.cells)
      ? artifact.cells
      : recordsFrom(nestedRecord(artifact, "reportInput").cells),
  };
}

function validationFailure(
  id: string,
  kind: string,
  validation: ValidationResult<unknown>,
): CliResult | undefined {
  if (validation.ok) return undefined;
  return fail(
    `Skill-bench ${kind} ${id} is malformed: ${validation.errors.join("; ")}.`,
  );
}

function artifactRoots(paths: SkillBenchPaths): string[] {
  return [paths.projectRoot, paths.globalRoot];
}

function pathContainedInRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

type SecureArtifactPath =
  | { status: "found"; filePath: string }
  | { status: "missing" }
  | { status: "rejected"; message: string };

function secureArtifactPath(
  id: string,
  kind: ArtifactKind,
  root: string,
  filePath: string,
): SecureArtifactPath {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return { status: "missing" };
  }
  if (rootStat.isSymbolicLink())
    return {
      status: "rejected",
      message: `Skill-bench artifact ${id} is not approved: ${kind} root is a symlink.`,
    };
  if (!rootStat.isDirectory()) return { status: "missing" };

  const relative = path.relative(root, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    return {
      status: "rejected",
      message: `Skill-bench artifact ${id} is not approved: ${kind} path escapes its trusted root.`,
    };

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return { status: "missing" };
    }
    if (stat.isSymbolicLink())
      return {
        status: "rejected",
        message: `Skill-bench artifact ${id} is not approved: ${kind} artifact path contains a symlink.`,
      };
  }

  if (!lstatSync(filePath).isFile()) return { status: "missing" };

  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(filePath);
    if (!pathContainedInRoot(realRoot, realFile))
      return {
        status: "rejected",
        message: `Skill-bench artifact ${id} is not approved: ${kind} artifact resolves outside its trusted root.`,
      };
  } catch {
    return {
      status: "rejected",
      message: `Skill-bench artifact ${id} is not approved: ${kind} artifact path cannot be verified.`,
    };
  }

  return { status: "found", filePath };
}

function loadArtifact(
  id: string,
  cwd: string,
  kinds: ArtifactKind[],
): LoadedArtifact | CliResult {
  if (!safeArtifactId(id)) {
    if (
      kinds.includes("run") &&
      !kinds.includes("draft") &&
      !kinds.includes("spec")
    )
      return fail(`Missing verified skill-bench run: ${id}.`);
    if (kinds.length === 1 && kinds[0] === "draft")
      return fail(`Missing persisted skill-bench draft: ${id}.`);
    return fail(`Missing approved skill-bench draft/spec: ${id}.`);
  }
  const paths = resolveSkillBenchPaths({ cwd });
  const candidates: Array<{ kind: ArtifactKind; root: string; filePath: string }> = [];
  for (const root of artifactRoots(paths)) {
    if (kinds.includes("draft"))
      candidates.push({
        kind: "draft",
        root,
        filePath: path.join(root, "drafts", id, "design.json"),
      });
    if (kinds.includes("spec"))
      candidates.push({
        kind: "spec",
        root,
        filePath: path.join(root, "specs", id, "manifest.json"),
      });
    if (kinds.includes("run"))
      candidates.push({
        kind: "run",
        root,
        filePath: path.join(root, "runs", id, "run.json"),
      });
  }
  const existing: Array<{ kind: ArtifactKind; filePath: string; trustedRoot: string }> = [];
  for (const candidate of candidates) {
    const resolved = secureArtifactPath(
      id,
      candidate.kind,
      candidate.root,
      candidate.filePath,
    );
    if (resolved.status === "rejected") return fail(resolved.message);
    if (resolved.status === "found")
      existing.push({
        kind: candidate.kind,
        filePath: resolved.filePath,
        trustedRoot: path.dirname(path.dirname(candidate.root)),
      });
  }
  if (existing.length === 0) {
    if (kinds.length === 1 && kinds[0] === "draft")
      return fail(`Missing persisted skill-bench draft: ${id}.`);
    if (kinds.length === 1 && kinds[0] === "run")
      return fail(`Missing verified skill-bench run: ${id}.`);
    if (kinds.includes("run") && kinds.includes("spec"))
      return fail(`Missing exportable skill-bench spec/run: ${id}.`);
    return fail(`Missing approved skill-bench draft/spec: ${id}.`);
  }
  if (existing.length > 1)
    return fail(
      `Skill-bench artifact ${id} is not approved: conflicting artifacts found.`,
    );
  try {
    const artifact = loadJsonFile(
      existing[0].filePath,
      existing[0].trustedRoot,
    );
    if (!isRecord(artifact))
      return fail(
        `Skill-bench artifact ${id} is not approved: artifact is invalid.`,
      );
    return {
      kind: existing[0].kind,
      id,
      path: existing[0].filePath,
      trustedRoot: existing[0].trustedRoot,
      artifact,
    };
  } catch {
    return fail(
      `Skill-bench artifact ${id} is not approved: artifact is invalid.`,
    );
  }
}

function draftRunRejection(id: string): CliResult {
  return fail(
    `Skill-bench run requires an approved frozen spec/manifest artifact; draft ${id} must be resumed and frozen/exported before execution.`,
  );
}

function loadApprovedSpec(
  id: string,
  cwd: string,
): LoadedArtifact | CliResult {
  const draft = loadArtifact(id, cwd, ["draft"]);
  if (!("ok" in draft)) return draftRunRejection(id);
  const loaded = loadArtifact(id, cwd, ["spec"]);
  if (!("ok" in loaded)) {
    const failure = validateApprovedArtifact(id, loaded.artifact, {
      stage: "source",
      artifactPath: loaded.path,
      trustedRoot: loaded.trustedRoot,
    });
    if (failure) return failure;
    const shapeFailure = validatePublicArtifactShape(id, loaded.artifact, "spec");
    if (shapeFailure) return shapeFailure;
  }
  return loaded;
}

function loadApprovedSpecTarget(
  target: string,
  cwd: string,
): LoadedArtifact | CliResult {
  if (looksLikePathTarget(target))
    return loadApprovedSpecPath(target, cwd);
  return loadApprovedSpec(target, cwd);
}

function looksLikePathTarget(target: string): boolean {
  return (
    target.includes("/") ||
    target.includes("\\") ||
    target.endsWith(".json") ||
    target === "." ||
    target === ".."
  );
}

function trustedRootForSpecPath(
  paths: SkillBenchPaths,
  cwd: string,
  filePath: string,
): string {
  const candidates = [
    path.resolve(cwd),
    path.dirname(path.dirname(paths.projectRoot)),
    path.dirname(path.dirname(paths.globalRoot)),
  ].filter((root) => pathContainedInRoot(root, filePath));
  candidates.sort((left, right) => right.length - left.length);
  return candidates[0] ?? path.dirname(filePath);
}

function loadApprovedSpecPath(
  target: string,
  cwd: string,
): LoadedArtifact | CliResult {
  const paths = resolveSkillBenchPaths({ cwd });
  const projectBase = path.dirname(path.dirname(paths.projectRoot));
  if (
    path.isAbsolute(target) &&
    !isPathInside(projectBase, path.resolve(target)) &&
    !isPathInside(cwd, path.resolve(target))
  )
    return fail(`Unsafe skill-bench artifact path: ${target}.`);
  if (!path.isAbsolute(target) && hasUnsafeRelativeParts(target))
    return fail(`Unsafe skill-bench artifact path: ${target}.`);
  const absoluteTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(cwd, target);
  if (
    !isPathInside(projectBase, absoluteTarget) &&
    !isPathInside(paths.globalRoot, absoluteTarget) &&
    !isPathInside(cwd, absoluteTarget)
  )
    return fail(`Unsafe skill-bench artifact path: ${target}.`);
  let filePath: string;
  try {
    const targetStat = lstatSync(absoluteTarget);
    if (targetStat.isSymbolicLink())
      return fail(`Unsafe skill-bench artifact path: ${target}.`);
    filePath = targetStat.isDirectory()
      ? path.join(absoluteTarget, "manifest.json")
      : absoluteTarget;
  } catch {
    return fail(`Missing approved skill-bench spec path: ${target}.`);
  }
  const normalized = path.resolve(filePath);
  const artifactClassFailure = validateSpecPathClass(target, normalized);
  if (artifactClassFailure) return artifactClassFailure;
  const trustedRoot = trustedRootForSpecPath(paths, cwd, normalized);
  const loaded = readRegularFileUtf8(normalized, trustedRoot);
  if (!loaded.ok) {
    if (loaded.reason === "missing")
      return fail(`Missing approved skill-bench spec path: ${target}.`);
    return fail(
      `Skill-bench artifact path ${target} is not approved: ${regularFileFailureReason(loaded.reason, "artifact path")}.`,
    );
  }
  try {
    const artifact = JSON.parse(loaded.content) as unknown;
    if (!isRecord(artifact))
      return fail(
        `Skill-bench artifact path ${target} is not approved: artifact is invalid.`,
      );
    const id =
      typeof artifact.id === "string"
        ? artifact.id
        : path.basename(path.dirname(normalized));
    if (!safeArtifactId(id))
      return fail(
        `Skill-bench artifact path ${target} is not approved: artifact id is invalid.`,
      );
    const failure = validateApprovedArtifact(id, artifact, {
      stage: "source",
      artifactPath: normalized,
      trustedRoot,
    });
    if (failure) return failure;
    const shapeFailure = validatePublicArtifactShape(id, artifact, "spec");
    if (shapeFailure) return shapeFailure;
    return { kind: "spec", id, path: normalized, trustedRoot, artifact };
  } catch {
    return fail(
      `Skill-bench artifact path ${target} is not approved: artifact is invalid.`,
    );
  }
}

function validateSpecPathClass(target: string, normalized: string): CliResult | null {
  if (path.extname(normalized) !== ".json")
    return fail(
      `Skill-bench artifact path ${target} is not approved: expected a JSON spec artifact.`,
    );
  const segments = normalized.split(path.sep);
  const basename = path.basename(normalized);
  const rejectedSegment = segments.find((segment) =>
    ["runs", "preflights", "drafts"].includes(segment),
  );
  const rejectedName = new Set([
    "run.json",
    "summary.json",
    "recommendation.json",
    "preflight.json",
    "design.json",
  ]);
  if (rejectedSegment || rejectedName.has(basename))
    return fail(
      `Skill-bench artifact path ${target} is not approved: expected a manifest/spec JSON artifact, not a run/report/draft artifact.`,
    );
  const isManifest = basename === "manifest.json";
  const isSpecNamed = /(^|[-_.])spec([-_.]|$)/i.test(basename);
  const underSpecs = segments.includes("specs");
  if (!isManifest && !isSpecNamed && !underSpecs)
    return fail(
      `Skill-bench artifact path ${target} is not approved: expected a manifest/spec JSON artifact.`,
    );
  return null;
}

function latestDraftId(cwd: string): string | CliResult {
  const paths = resolveSkillBenchPaths({ cwd });
  const candidates: Array<{ id: string; filePath: string; mtimeMs: number }> = [];
  for (const root of artifactRoots(paths)) {
    const draftsDir = path.join(root, "drafts");
    if (!existsSync(draftsDir)) continue;
    for (const entry of readdirSync(draftsDir, { withFileTypes: true })) {
      if (!safeArtifactId(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const filePath = path.join(draftsDir, entry.name, "design.json");
      const resolved = secureArtifactPath(entry.name, "draft", root, filePath);
      if (resolved.status === "rejected") return fail(resolved.message);
      if (resolved.status !== "found") continue;
      candidates.push({
        id: entry.name,
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
      });
    }
  }
  if (candidates.length === 0)
    return fail(
      "Missing persisted skill-bench draft: no durable drafts found.",
    );
  candidates.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath),
  );
  return candidates[0].id;
}

function loadPersistedDraft(
  id: string,
  cwd: string,
): LoadedArtifact | CliResult {
  return loadArtifact(id, cwd, ["draft"]);
}

function draftLedgerPath(draft: LoadedArtifact): string {
  return path.join(path.dirname(draft.path), "approvals.jsonl");
}

function draftCurrentSpec(draft: LoadedArtifact): Record<string, unknown> | null {
  const imported = nestedRecord(draft.artifact, "importedManifest");
  return Object.keys(imported).length > 0 ? imported : null;
}

function appendDraftLedger(draft: LoadedArtifact, event: Record<string, unknown>): void {
  const ledgerPath = draftLedgerPath(draft);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const opened = openRegularFile(
    ledgerPath,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    { rejectHardlinks: true, trustedRoot: draft.trustedRoot },
  );
  if (!opened.ok) throw new Error(approvalLedgerFailureReason(opened.reason));
  try {
    writeAllSync(opened.fd, `${JSON.stringify(event)}\n`);
    fsyncSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
}

function materializeReviewedManifest(
  manifest: Record<string, unknown>,
  importPath: string,
  draft: LoadedArtifact,
): Record<string, unknown> | CliResult {
  const draftDir = path.dirname(draft.path);
  const bundleDir = path.join(draftDir, "bundle");
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });

  const skill = nestedRecord(manifest, "skill");
  const skillPath = stringFromAnyKey(skill, ["path", "canonicalPath", "sourcePath"]);
  if (!skillPath) {
    return fail("Reviewed skill-bench manifest requires a selected skill path.");
  }
  const sourceSkill = resolveReviewedSourcePath(skillPath, importPath);
  const targetSkill = path.join(bundleDir, "skill");
  try {
    copyFrozenDirectory(sourceSkill, targetSkill, "selected skill");
  } catch (error) {
    return fail(
      `Reviewed skill-bench manifest has an invalid selected skill: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const skillFingerprint = fingerprintSkillDirectory(targetSkill);
  if (
    typeof skill.fingerprint === "string" &&
    skill.fingerprint !== skillFingerprint
  ) {
    return fail("Reviewed skill-bench manifest selected skill fingerprint is stale.");
  }
  const {
    path: _skillPath,
    canonicalPath: _canonicalPath,
    sourcePath: _sourcePath,
    sourceUri: _sourceUri,
    ...safeSkill
  } = skill;

  const evaluation = nestedRecord(manifest, "evaluation");
  const evaluator = nestedRecord(evaluation, "evaluator");
  const evaluatorPath = stringFromAnyKey(evaluator, ["path"]);
  if (!evaluatorPath || typeof evaluator.sha256 !== "string") {
    return fail("Reviewed skill-bench manifest requires a frozen evaluator descriptor.");
  }
  const sourceEvaluator = resolveReviewedSourcePath(evaluatorPath, importPath);
  const targetEvaluator = path.join(bundleDir, "evaluator.mjs");
  try {
    const stats = lstatSync(sourceEvaluator);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("evaluator must be a real file");
    }
    if (hashFile(sourceEvaluator) !== evaluator.sha256.toLowerCase()) {
      throw new Error("evaluator fingerprint is stale");
    }
    cpSync(sourceEvaluator, targetEvaluator, { force: false, dereference: false });
  } catch (error) {
    return fail(
      `Reviewed skill-bench manifest has an invalid evaluator: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const scenarios = recordsFrom(manifest.scenarios).map((scenario) => {
    const fixturePath = stringFromAnyKey(scenario, ["fixturePath", "visibleFixturePath"]);
    if (!fixturePath) return { ...scenario };
    const scenarioId = stringFromAnyKey(scenario, ["id"]);
    if (!scenarioId || !safeArtifactId(scenarioId)) {
      throw new Error("fixture scenario id is unsafe");
    }
    const sourceFixture = resolveReviewedSourcePath(fixturePath, importPath);
    const targetFixture = path.join(bundleDir, "fixtures", scenarioId);
    copyFrozenDirectory(sourceFixture, targetFixture, `fixture ${scenarioId}`);
    const fingerprint = fingerprintSkillDirectory(targetFixture);
    if (
      typeof scenario.visibleFixtureFingerprint === "string" &&
      scenario.visibleFixtureFingerprint !== fingerprint
    ) {
      throw new Error(`fixture ${scenarioId} fingerprint is stale`);
    }
    const {
      fixturePath: _fixturePath,
      visibleFixturePath: _visibleFixturePath,
      ...safeScenario
    } = scenario;
    return {
      ...safeScenario,
      fixturePath: `bundle/fixtures/${scenarioId}`,
      visibleFixtureFingerprint: fingerprint,
    };
  });
  const specId = String(manifest.id);
  const fingerprint = nestedRecord(manifest, "fingerprint");
  const specPrefix = path.posix.join("specs", specId);
  const bundleFiles = listRegularFiles(bundleDir).map((file) =>
    path.posix.join(
      specPrefix,
      path.relative(draftDir, file).split(path.sep).join("/"),
    ),
  );
  return {
    ...manifest,
    fingerprint: { ...fingerprint, status: "current" },
    skill: { ...safeSkill, path: "bundle/skill", fingerprint: skillFingerprint },
    scenarios,
    evaluation: {
      ...evaluation,
      command: ["node", "bundle/evaluator.mjs"],
      evaluator: {
        ...evaluator,
        path: "bundle/evaluator.mjs",
        approvedRoot: "bundle",
      },
    },
    exportManifest: {
      files: [
        path.posix.join(specPrefix, "manifest.json"),
        path.posix.join(specPrefix, "approvals.jsonl"),
        ...bundleFiles,
      ],
    },
  };
}

function resolveReviewedSourcePath(storedPath: string, importPath: string): string {
  return path.isAbsolute(storedPath)
    ? path.resolve(storedPath)
    : path.resolve(path.dirname(importPath), storedPath);
}

function copyFrozenDirectory(source: string, target: string, label: string): void {
  if (!existsSync(source)) throw new Error(`${label} is missing`);
  const stats = lstatSync(source);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  fingerprintSkillDirectory(source);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, dereference: false });
  fingerprintSkillDirectory(target);
}

function listRegularFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const target = path.join(directory, entry);
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error("frozen bundle contains a symlink");
    if (stats.isDirectory()) files.push(...listRegularFiles(target));
    else if (stats.isFile()) files.push(target);
  }
  return files;
}

function importReviewedManifest(
  id: string,
  draft: LoadedArtifact,
  target: string,
  cwd: string,
): CliResult {
  if (path.isAbsolute(target) || hasUnsafeRelativeParts(target))
    return fail(`Unsafe skill-bench artifact path: ${target}.`);
  const importPath = path.resolve(cwd, target);
  if (!isPathInside(cwd, importPath) || !existsSync(importPath) || !lstatSync(importPath).isFile())
    return fail(`Missing reviewed skill-bench manifest: ${target}.`);
  try {
    let reviewedPath = importPath;
    let manifest = loadJsonFile(reviewedPath, path.resolve(cwd));
    if (isRecord(manifest) && manifest.bundleType === "skill-bench-json-v1") {
      const extracted = extractPortableReviewedManifest(manifest, draft);
      if (isCliFailure(extracted)) return extracted;
      reviewedPath = extracted;
      manifest = loadJsonFile(reviewedPath, draft.trustedRoot);
    }
    if (!isRecord(manifest)) return fail(`Reviewed skill-bench manifest ${target} is invalid.`);
    const validation = validateSkillBenchSpecV1(manifest);
    const failure = validationFailure(id, "spec", validation);
    if (failure) return failure;
    const requirementFailure = validateReviewedManifestFreezeRequirements(id, manifest);
    if (requirementFailure) return requirementFailure;
    const materialized = materializeReviewedManifest(
      manifest,
      reviewedPath,
      draft,
    );
    if (isCliFailure(materialized)) return materialized;
    const materializedFailure = validationFailure(
      id,
      "spec",
      validateSkillBenchSpecV1(materialized),
    );
    if (materializedFailure) return materializedFailure;
    const updated = {
      ...draft.artifact,
      importedManifest: materialized,
      importedManifestPath: importPath,
      importedSpecContentHash: specContentHash(materialized),
      approvals: { frozen: false, budget: false, liveCellsAllowed: false },
    };
    writeJsonFile(draft.path, updated, draft.trustedRoot);
    appendDraftLedger({ ...draft, artifact: updated }, {
      schemaVersion: 1,
      type: "import",
      specContentHash: specContentHash(materialized),
      sourcePath: path.relative(cwd, importPath) || path.basename(importPath),
      importedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      message: `Resumed skill-bench draft ${id}: imported reviewed manifest\nspec-hash=${specContentHash(materialized)}`,
      output: { schemaVersion: 1, phase: "design", id, status: "imported" },
    };
  } catch {
    return fail(`Reviewed skill-bench manifest ${target} is invalid.`);
  }
}

function extractPortableReviewedManifest(
  bundle: Record<string, unknown>,
  draft: LoadedArtifact,
): string | CliResult {
  if (bundle.artifactKind !== "spec") {
    return fail("Portable skill-bench import requires a spec bundle; run bundles are archival.");
  }
  const sourcePath = stringField(bundle, "sourcePath");
  const files = Array.isArray(bundle.files) ? bundle.files : [];
  const integrity = nestedRecord(bundle, "integrity");
  if (
    !sourcePath ||
    isAnyAbsolutePath(sourcePath) ||
    hasUnsafeRelativeParts(sourcePath) ||
    files.length === 0 ||
    integrity.algorithm !== "sha256" ||
    typeof integrity.sha256 !== "string" ||
    integrity.sha256 !== sha256Json(files)
  ) {
    return fail("Portable skill-bench import failed bundle integrity validation.");
  }

  const decoded: Array<{ path: string; bytes: Buffer; content: string }> = [];
  for (const value of files) {
    if (!isRecord(value))
      return fail("Portable skill-bench import contains an invalid file entry.");
    const filePath = stringField(value, "path");
    const content = stringField(value, "content");
    const declaredSha256 = stringField(value, "sha256");
    if (
      !filePath ||
      isAnyAbsolutePath(filePath) ||
      hasUnsafeRelativeParts(filePath) ||
      value.encoding !== "base64" ||
      content === undefined ||
      !declaredSha256
    ) {
      return fail("Portable skill-bench import contains an unsafe file entry.");
    }
    const bytes = Buffer.from(content, "base64");
    if (
      bytes.toString("base64") !== content ||
      createHash("sha256").update(bytes).digest("hex") !== declaredSha256 ||
      (typeof value.sizeBytes === "number" && value.sizeBytes !== bytes.length)
    ) {
      return fail(`Portable skill-bench import failed sha256 integrity for ${filePath}.`);
    }
    decoded.push({ path: filePath, bytes, content: bytes.toString("utf8") });
  }
  if (!decoded.some((file) => file.path === sourcePath)) {
    return fail("Portable skill-bench import is missing its source manifest.");
  }
  const privacy = preflightSkillBenchExport({ files: decoded });
  if (!privacy.ok) {
    return fail(`Portable skill-bench import failed privacy review: ${privacy.errors.join("; ")}.`);
  }

  const stagingRoot = path.join(
    path.dirname(draft.path),
    "portable-import",
    integrity.sha256.slice(0, 16),
  );
  rmSync(stagingRoot, { recursive: true, force: true });
  for (const file of decoded) {
    const destination = path.resolve(stagingRoot, file.path);
    if (!isPathInside(stagingRoot, destination)) {
      return fail(`Portable skill-bench import path escapes staging root: ${file.path}.`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeTrustedFile(destination, file.bytes, draft.trustedRoot);
  }
  const manifestPath = path.resolve(stagingRoot, sourcePath);
  return isPathInside(stagingRoot, manifestPath) && existsSync(manifestPath)
    ? manifestPath
    : fail("Portable skill-bench import is missing its extracted source manifest.");
}

function approveDraftGate(id: string, draft: LoadedArtifact, gate: string): CliResult {
  const spec = draftCurrentSpec(draft);
  if (!spec) return fail(`Skill-bench draft ${id} has no imported manifest to approve.`);
  const allowed = new Set(designGateIds());
  if (!allowed.has(gate)) return fail(`unknown design gate: ${gate}`);
  const hash = specContentHash(spec);
  const ledgerPath = draftLedgerPath(draft);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const opened = openRegularFile(
    ledgerPath,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    { rejectHardlinks: true, trustedRoot: draft.trustedRoot },
  );
  if (!opened.ok)
    return fail(
      `Skill-bench draft ${id} ${approvalLedgerFailureReason(opened.reason)}.`,
    );
  try {
    for (const line of readFileSync(opened.fd, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as unknown;
      if (isRecord(event) && event.type === "approval" && event.gateId === gate && event.specContentHash === hash)
        return fail(`Skill-bench draft ${id} approval for ${gate} is append-only for current spec hash.`);
    }
    writeAllSync(
      opened.fd,
      `${JSON.stringify({
        schemaVersion: 1,
        type: "approval",
        gateId: gate,
        approved: true,
        specContentHash: hash,
        approvedAt: new Date().toISOString(),
      })}\n`,
    );
    fsyncSync(opened.fd);
  } catch {
    return fail(`Skill-bench draft ${id} approval ledger is invalid.`);
  } finally {
    closeSync(opened.fd);
  }
  return {
    ok: true,
    message: `Resumed skill-bench draft ${id}: approved gate ${gate}\nspec-hash=${hash}`,
    output: { schemaVersion: 1, phase: "design", id, status: "approved", gate },
  };
}

function freezeDraftSpec(id: string, draft: LoadedArtifact, cwd: string): CliResult {
  const spec = draftCurrentSpec(draft);
  if (!spec) return fail(`Skill-bench draft ${id} has no imported manifest to freeze.`);
  const hash = specContentHash(spec);
  const approvedLedger = validatedDraftLedgerForFreeze(id, draft, hash);
  if (isCliFailure(approvedLedger)) return approvedLedger;
  const freezeRequirementFailure = validateReviewedManifestFreezeRequirements(id, spec);
  if (freezeRequirementFailure) return freezeRequirementFailure;
  const frozenSpec = freezeReviewedManifestV1(spec);
  const validationFailureResult = validationFailure(
    id,
    "spec",
    validateSkillBenchSpecV1(frozenSpec),
  );
  if (validationFailureResult) return validationFailureResult;
  const specId = typeof frozenSpec.id === "string" ? frozenSpec.id : id;
  if (!safeArtifactId(specId)) return fail(`Skill-bench draft ${id} cannot freeze unsafe spec id.`);
  const paths = resolveSkillBenchPaths({ cwd });
  const scope = artifactScope(paths, draft.path);
  const manifestRelative = path.posix.join("specs", specId, "manifest.json");
  const draftBundle = path.join(path.dirname(draft.path), "bundle");
  if (!existsSync(draftBundle)) {
    return fail(`Skill-bench draft ${id} is missing its reviewed frozen bundle.`);
  }
  let specDir: string;
  try {
    specDir = reserveSkillBenchArtifactRoot(
      paths,
      scope,
      path.posix.join("specs", specId),
      "spec",
      specId,
    );
  } catch (error) {
    return fail(
      `Skill-bench draft ${id} cannot reserve frozen spec output safely: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (existsSync(path.join(specDir, "manifest.json"))) {
    return fail(`Skill-bench spec ${specId} is already frozen and immutable.`);
  }
  let manifestPath: string;
  try {
    cpSync(draftBundle, path.join(specDir, "bundle"), {
      recursive: true,
      force: false,
      dereference: false,
    });
    manifestPath = writeSkillBenchJsonAtomic(
      paths,
      scope,
      manifestRelative,
      frozenSpec,
    );
    const specLedger = path.join(path.dirname(manifestPath), "approvals.jsonl");
    mkdirSync(path.dirname(specLedger), { recursive: true });
    writeTrustedFile(
      specLedger,
      `${approvedLedger.content}${JSON.stringify({ schemaVersion: 1, type: "freeze", status: "frozen", specContentHash: hash, approvedAt: new Date().toISOString() })}\n`,
      scopeBaseFromPaths(paths, scope),
    );
    writeJsonFile(draft.path, {
      ...draft.artifact,
      frozenSpecId: specId,
      frozenSpecPath: manifestPath,
      approvals: { frozen: true, budget: true, liveCellsAllowed: false },
    }, draft.trustedRoot);
  } catch (error) {
    return fail(
      `Skill-bench draft ${id} could not materialize frozen spec safely: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  return {
    ok: true,
    message: `Resumed skill-bench draft ${id}: frozen spec exported\nspec-id=${specId}\nspec: ${displayPath(cwd, manifestPath)}\nlive-cells=blocked\nnext: omp skill-bench run ${specId} --pilot --approve-spend`,
    output: { schemaVersion: 1, phase: "design", id, status: "frozen", specId },
  };
}

function validatedDraftLedgerForFreeze(
  id: string,
  draft: LoadedArtifact,
  hash: string,
): { ok: true; content: string } | CliResult {
  const ledgerPath = draftLedgerPath(draft);
  const ledger = readRegularFileUtf8(ledgerPath, draft.trustedRoot);
  if (!ledger.ok)
    return fail(
      `Skill-bench draft ${id} ${approvalLedgerFailureReason(ledger.reason)}.`,
    );
  try {
    const validation = validateDesignApprovalLedgerV1(
      ledger.content,
      hash,
      { requireFreeze: false },
    );
    return validation.ok
      ? { ok: true, content: ledger.content }
      : fail(`Skill-bench draft ${id} ${validation.reason}.`);
  } catch {
    return fail(`Skill-bench draft ${id} approval ledger is invalid.`);
  }
}

function loadCompletedRun(id: string, cwd: string): LoadedArtifact | CliResult {
  const loaded = loadArtifact(id, cwd, ["run"]);
  if (!("ok" in loaded)) {
    const failure = validateApprovedArtifact(id, loaded.artifact, {
      stage: "completed-run",
      artifactPath: loaded.path,
      trustedRoot: loaded.trustedRoot,
    });
    if (failure) return failure;
    const shapeFailure = validatePublicArtifactShape(id, loaded.artifact, "run");
    if (shapeFailure) return shapeFailure;
  }
  return loaded;
}

function loadApplicableRun(id: string, cwd: string): LoadedArtifact | CliResult {
  const loaded = loadArtifact(id, cwd, ["run"]);
  if (!("ok" in loaded)) {
    const failure = validateApprovedArtifact(id, loaded.artifact, {
      stage: "applicable-run",
      artifactPath: loaded.path,
      trustedRoot: loaded.trustedRoot,
    });
    if (failure) return failure;
    const shapeFailure = validatePublicArtifactShape(id, loaded.artifact, "run");
    if (shapeFailure) return shapeFailure;
  }
  return loaded;
}

function loadExportableSpecOrRun(
  id: string,
  cwd: string,
): LoadedArtifact | CliResult {
  const loaded = loadArtifact(id, cwd, ["spec", "run"]);
  if (!("ok" in loaded)) {
    const failure = validateApprovedArtifact(id, loaded.artifact, {
      stage: loaded.kind === "run" ? "completed-run" : "source",
      artifactPath: loaded.path,
      trustedRoot: loaded.trustedRoot,
    });
    if (failure) return failure;
    const shapeFailure = validatePublicArtifactShape(id, loaded.artifact, loaded.kind === "run" ? "run" : "spec");
    if (shapeFailure) return shapeFailure;
  }
  return loaded;
}

function isCliFailure(value: unknown): value is CliResult {
  return isRecord(value) && value.ok === false;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function artifactScope(
  paths: SkillBenchPaths,
  artifactPath: string,
): SkillBenchScope {
  const resolved = path.resolve(artifactPath);
  const projectRelative = path.relative(paths.projectRoot, resolved);
  if (!projectRelative.startsWith("..") && !path.isAbsolute(projectRelative))
    return "project";
  const globalRelative = path.relative(paths.globalRoot, resolved);
  if (!globalRelative.startsWith("..") && !path.isAbsolute(globalRelative))
    return "global";
  throw new Error("artifact is outside skill-bench roots");
}
function sourceScope(
  paths: SkillBenchPaths,
  artifactPath: string,
): SkillBenchScope {
  try {
    return artifactScope(paths, artifactPath);
  } catch {
    const projectBase = path.dirname(path.dirname(paths.projectRoot));
    if (isPathInside(projectBase, path.resolve(artifactPath))) return "project";
    throw new Error("artifact is outside skill-bench roots");
  }
}

function artifactRoot(paths: SkillBenchPaths, scope: SkillBenchScope): string {
  return scope === "project" ? paths.projectRoot : paths.globalRoot;
}

function reserveSkillBenchArtifactRoot(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  relativeRoot: string,
  kind: "run" | "spec",
  id: string,
): string {
  const reservationPath = resolveSkillBenchOutputPath(
    paths,
    scope,
    path.posix.join(relativeRoot, ".skill-bench-reservation.json"),
  );
  mkdirSync(path.dirname(reservationPath), { recursive: true });
  const trustedRoot = scopeBaseFromPaths(paths, scope);
  const content = `${canonicalJson({ schemaVersion: 1, kind, id })}\n`;
  createTextFileIfMissing(reservationPath, () => content, trustedRoot);
  const persisted = readRegularFileUtf8(reservationPath, trustedRoot);
  if (!persisted.ok)
    throw new Error(
      regularFileFailureReason(persisted.reason, `${kind} output reservation`),
    );
  if (persisted.content !== content)
    throw new Error(`${kind} output reservation does not match ${id}`);
  return path.dirname(reservationPath);
}

function artifactRelativePath(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  artifactPath: string,
): string {
  return path
    .relative(artifactRoot(paths, scope), artifactPath)
    .split(path.sep)
    .join(path.posix.sep);
}

function safeSourceReference(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  source: LoadedArtifact,
): string {
  const root = artifactRoot(paths, scope);
  return isPathInside(root, source.path)
    ? artifactRelativePath(paths, scope, source.path)
    : `external-spec/${source.id}`;
}

function isPathInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))
    return true;
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realTarget = existsSync(resolvedTarget)
      ? realpathSync(resolvedTarget)
      : path.join(realpathSync(path.dirname(resolvedTarget)), path.basename(resolvedTarget));
    const realRelative = path.relative(realRoot, realTarget);
    return (
      realRelative === "" ||
      (!realRelative.startsWith("..") && !path.isAbsolute(realRelative))
    );
  } catch {
    return false;
  }
}

function isAnyAbsolutePath(storedPath: string): boolean {
  return path.isAbsolute(storedPath) || path.win32.isAbsolute(storedPath);
}

function hasUnsafeRelativeParts(storedPath: string): boolean {
  return storedPath
    .split(/[\\/]+/)
    .some((part) => part === ".." || part === "");
}

function scopeBaseFromPaths(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
): string {
  return path.dirname(path.dirname(artifactRoot(paths, scope)));
}

function reportPathForRun(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  runId: string,
): string {
  return path.join(
    artifactRoot(paths, scope),
    "runs",
    runId,
    "sweep_report.html",
  );
}

function displayPath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || filePath;
}

function storedPathToAbsolute(
  storedPath: string,
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  artifactDir: string,
): string | null {
  if (isAnyAbsolutePath(storedPath)) return null;
  if (hasUnsafeRelativeParts(storedPath)) return null;
  const root = artifactRoot(paths, scope);
  const normalized = storedPath.split(path.sep).join("/");
  const base =
    storedPath.startsWith(`.omp${path.sep}`) || storedPath.startsWith(".omp/")
      ? scopeBaseFromPaths(paths, scope)
      : /^(?:runs|specs|drafts|preflights|reruns)\//.test(normalized)
        ? root
        : artifactDir;
  const absolute = path.resolve(base, storedPath);
  return isPathInside(root, absolute) ? absolute : null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function persistRunApprovalProof(
  source: LoadedArtifact,
  runRoot: string,
  trustedRoot: string,
): { specContentHash: string; ledgerSha256: string } {
  const sourceLedgerPath = path.join(path.dirname(source.path), "approvals.jsonl");
  const sourceLedger = readRegularFileUtf8(
    sourceLedgerPath,
    source.trustedRoot,
  );
  if (!sourceLedger.ok)
    throw new Error(approvalLedgerFailureReason(sourceLedger.reason));
  const ledger = sourceLedger.content;
  const validation = resolveApprovalLedgerBinding(
    source.artifact,
    ledger,
    true,
  );
  if (!validation.ok) throw new Error(validation.reason);
  writeTrustedFile(path.join(runRoot, "approvals.jsonl"), ledger, trustedRoot);
  return {
    specContentHash: validation.specContentHash,
    ledgerSha256: sha256Text(ledger),
  };
}

function runRecommendation(
  artifact: Record<string, unknown>,
): RoutingRecommendationV1 | null {
  const recommendation = nestedRecord(artifact, "recommendation");
  if (
    recommendation.schemaVersion === 1 &&
    typeof recommendation.id === "string" &&
    typeof recommendation.runId === "string"
  )
    return recommendation as unknown as RoutingRecommendationV1;
  return null;
}

function copilotAdvisoryCapabilities(
  recommendation: RoutingRecommendationV1 | null,
): RoutingCapabilityEntryV1[] {
  return recommendation
    ? buildRoutingCapabilityProtocolV1({
        recommendation,
        surfaces: [
          {
            surface: "copilot-interactive",
            provider: "copilot",
            ownedLaunch: false,
            supportsEnforcedRoute: false,
            capturedEffectiveRoute: null,
          },
        ],
      })
    : [];
}

function currentFingerprints(
  artifact: Record<string, unknown>,
): {
  skill: string;
  model: string;
  spec: string;
  evaluation: string;
  provider: string;
} | null {
  const current = nestedRecord(artifact, "currentFingerprints");
  const keys = ["skill", "model", "spec", "evaluation", "provider"] as const;
  if (
    !keys.every(
      (key) => typeof current[key] === "string" && current[key] !== "",
    )
  )
    return null;
  return {
    skill: current.skill as string,
    model: current.model as string,
    spec: current.spec as string,
    evaluation: current.evaluation as string,
    provider: current.provider as string,
  };
}

type RerunFingerprintKey =
  | "skill"
  | "model"
  | "spec"
  | "evaluation"
  | "provider"
  | "pricing";

type RerunFingerprintGate = {
  status: "ready" | "blocked";
  matches: Record<string, string>;
  missing: string[];
  stale: Array<{ key: string; frozen: string; current: string }>;
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" && record[key] !== ""
    ? (record[key] as string)
    : null;
}

function currentRerunFingerprints(
  artifact: Record<string, unknown>,
): Partial<Record<RerunFingerprintKey, string>> {
  const current = nestedRecord(artifact, "currentFingerprints");
  const singular = nestedRecord(artifact, "currentFingerprint");
  return {
    skill: firstString(current.skill, singular.skill) ?? undefined,
    model: firstString(current.model, singular.model) ?? undefined,
    spec: firstString(current.spec, singular.spec) ?? undefined,
    evaluation: firstString(current.evaluation, singular.evaluation) ?? undefined,
    provider: firstString(current.provider, singular.provider) ?? undefined,
    pricing: firstString(current.pricing, singular.pricing) ?? undefined,
  };
}

function frozenRerunFingerprints(
  artifact: Record<string, unknown>,
): Partial<Record<RerunFingerprintKey, string>> {
  const recommendation = nestedRecord(artifact, "recommendation");
  const selectedSkill = nestedRecord(recommendation, "selectedSkill");
  const selectedModel = nestedRecord(recommendation, "selectedModel");
  const recommendationFingerprints = nestedRecord(recommendation, "fingerprints");
  const reportInput = nestedRecord(artifact, "reportInput");
  const reportSpec = nestedRecord(reportInput, "spec");
  const reportSkill = nestedRecord(reportInput, "skill");
  const reportModel = nestedRecord(reportInput, "model");
  const environment = nestedRecord(reportInput, "environment");
  const pricing = nestedRecord(reportInput, "pricing");
  const runFingerprints = nestedRecord(artifact, "fingerprints");
  return {
    skill: firstString(selectedSkill.fingerprint, reportSkill.fingerprint, runFingerprints.skill) ?? undefined,
    model: firstString(selectedModel.fingerprint, reportModel.fingerprint, runFingerprints.model) ?? undefined,
    spec:
      firstString(
        recommendationFingerprints.spec,
        reportSpec.fingerprint,
        runFingerprints.spec,
      ) ?? undefined,
    evaluation:
      firstString(
        recommendationFingerprints.evaluation,
        reportSpec.evaluationFingerprint,
        runFingerprints.evaluation,
      ) ?? undefined,
    provider:
      firstString(
        recommendationFingerprints.provider,
        environment.fingerprint,
        runFingerprints.provider,
      ) ?? undefined,
    pricing:
      firstString(
        recommendationFingerprints.pricing,
        optionalString(pricing, "fingerprint"),
        runFingerprints.pricing,
      ) ?? undefined,
  };
}

function evaluateRerunFingerprintGate(
  artifact: Record<string, unknown>,
): RerunFingerprintGate {
  const requiredKeys: RerunFingerprintKey[] = [
    "skill",
    "model",
    "spec",
    "evaluation",
    "provider",
  ];
  const frozen = frozenRerunFingerprints(artifact);
  const current = currentRerunFingerprints(artifact);
  const keys: RerunFingerprintKey[] = frozen.pricing
    ? [...requiredKeys, "pricing"]
    : requiredKeys;
  const matches: Record<string, string> = {};
  const missing: string[] = [];
  const stale: Array<{ key: string; frozen: string; current: string }> = [];
  for (const key of keys) {
    const frozenValue = frozen[key];
    const currentValue = current[key];
    if (!frozenValue) missing.push(`frozen.${key}`);
    if (!currentValue) missing.push(`current.${key}`);
    if (!frozenValue || !currentValue) continue;
    if (frozenValue !== currentValue) stale.push({ key, frozen: frozenValue, current: currentValue });
    else matches[key] = currentValue;
  }
  return {
    status: missing.length === 0 && stale.length === 0 ? "ready" : "blocked",
    matches,
    missing,
    stale,
  };
}

function withLiveRerunFingerprints(
  artifact: Record<string, unknown>,
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
): Record<string, unknown> {
  const sourceReference = stringField(artifact, "sourcePath");
  if (!sourceReference) return artifact;
  const current = { ...currentRerunFingerprints(artifact) };
  const without = (key: RerunFingerprintKey): void => {
    delete current[key];
  };
  if (
    sourceReference.startsWith("external-spec/") ||
    hasUnsafeRelativeParts(sourceReference)
  ) {
    without("spec");
    return { ...artifact, currentFingerprints: current };
  }
  const sourcePath = path.resolve(artifactRoot(paths, scope), sourceReference);
  if (
    !isPathInside(artifactRoot(paths, scope), sourcePath) ||
    !existsSync(sourcePath) ||
    !lstatSync(sourcePath).isFile()
  ) {
    without("spec");
    return { ...artifact, currentFingerprints: current };
  }
  try {
    const sourceArtifact = loadJsonFile(
      sourcePath,
      path.dirname(path.dirname(artifactRoot(paths, scope))),
    );
    if (!isRecord(sourceArtifact)) throw new Error("source manifest is invalid");
    const sourceFingerprint = stringField(artifact, "sourceFingerprint");
    if (sourceFingerprint && stableId(sourceArtifact) !== sourceFingerprint) {
      current.spec = `changed-source-${stableId(sourceArtifact)}`;
    }
    if (artifact.synthetic === true) {
      return { ...artifact, currentFingerprints: current };
    }

    const validationFailure = validateApprovedArtifact(
      stringField(artifact, "sourceId") ?? "source",
      sourceArtifact,
      {
        stage: "source",
        artifactPath: sourcePath,
        trustedRoot: path.dirname(path.dirname(artifactRoot(paths, scope))),
      },
    );
    current.spec = validationFailure
      ? `invalid-source-${stableId(validationFailure.message ?? "approval")}`
      : specContentHash(sourceArtifact);

    const scenarios = specScenarios(sourceArtifact);
    for (const scenario of scenarios) {
      const storedFixturePath = stringFromAnyKey(scenario, [
        "fixturePath",
        "visibleFixturePath",
      ]);
      if (!storedFixturePath) continue;
      const expected = stringFromAnyKey(scenario, [
        "visibleFixtureFingerprint",
      ]);
      const fixturePath = path.isAbsolute(storedFixturePath)
        ? storedFixturePath
        : path.resolve(path.dirname(sourcePath), storedFixturePath);
      const actual = fingerprintSkillDirectory(fixturePath);
      if (!expected || actual !== expected) {
        current.spec = `stale-fixture-${stableId({ storedFixturePath, actual })}`;
        break;
      }
    }

    const skill = nestedRecord(sourceArtifact, "skill");
    const storedSkillPath = stringFromAnyKey(skill, [
      "path",
      "canonicalPath",
      "sourcePath",
    ]);
    if (storedSkillPath) {
      const skillPath = path.isAbsolute(storedSkillPath)
        ? storedSkillPath
        : path.resolve(path.dirname(sourcePath), storedSkillPath);
      current.skill = fingerprintSkillDirectory(skillPath);
    } else {
      without("skill");
    }
    current.model = stableId({ models: specModels(sourceArtifact) });
    const evaluation = frozenEvaluator(sourceArtifact, sourcePath);
    if (isCliFailure(evaluation)) without("evaluation");
    else current.evaluation = hashFile(evaluation.evaluator.path);
    current.provider = PROVIDER_TRANSPORT_FINGERPRINT;
  } catch {
    current.spec = `invalid-source-${stableId(sourceReference)}`;
  }
  return { ...artifact, currentFingerprints: current };
}

function rerunBlockedReason(gate: RerunFingerprintGate): string {
  const parts: string[] = [];
  if (gate.missing.length > 0) parts.push(`missing ${gate.missing.join(", ")}`);
  if (gate.stale.length > 0)
    parts.push(`stale ${gate.stale.map((item) => item.key).join(", ")}`);
  return parts.join("; ") || "fingerprints are not reproducible";
}

function routeRules(value: unknown): RouteRule[] {
  return Array.isArray(value)
    ? value.filter(isRecord).map((rule) => rule as unknown as RouteRule)
    : [];
}

function routingCapabilities(value: unknown): RoutingCapabilityEntryV1[] {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map((entry) => entry as unknown as RoutingCapabilityEntryV1)
    : [];
}

function stringFromAnyKey(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function evidencePathUnderRun(
  paths: SkillBenchPaths,
  run: LoadedArtifact,
  scope: SkillBenchScope,
  storedPath: string,
): string | null {
  const runRoot = path.dirname(run.path);
  const absolute = storedPathToAbsolute(storedPath, paths, scope, runRoot);
  if (!absolute || !isPathInside(runRoot, absolute)) return null;
  return absolute;
}

function isHashBoundRouteEvidence(input: {
  evidence: unknown;
  fileSha256: string;
  capability: Record<string, unknown>;
  recommendation: RoutingRecommendationV1;
  runId: string;
}): boolean {
  if (!isRecord(input.evidence)) return false;
  const declaredFileHash = stringFromAnyKey(input.capability, [
    "verificationEvidenceSha256",
    "evidenceSha256",
    "sha256",
  ]);
  if (!declaredFileHash || declaredFileHash !== input.fileSha256) return false;
  if (input.evidence.runId !== input.runId) return false;
  const recommendationHash = sha256Json(input.recommendation);
  const declaredRecommendationHash = stringFromAnyKey(input.evidence, [
    "recommendationSha256",
    "recommendationHash",
  ]);
  if (declaredRecommendationHash !== recommendationHash) return false;
  const desiredRoute = nestedRecord(input.evidence, "desiredRoute");
  const effectiveRoute = nestedRecord(input.evidence, "effectiveRoute");
  return (
    desiredRoute.skillId === input.recommendation.selectedSkill.id &&
    desiredRoute.modelId === input.recommendation.selectedModel.id &&
    effectiveRoute.skillId === input.recommendation.selectedSkill.id &&
    effectiveRoute.modelId === input.recommendation.selectedModel.id
  );
}

function verifiedRoutingCapabilities(
  run: LoadedArtifact,
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  recommendation: RoutingRecommendationV1,
): RoutingCapabilityEntryV1[] {
  return routingCapabilities(run.artifact.routingCapabilities).map((entry) => {
    const rawEntry = entry as unknown as Record<string, unknown>;
    const storedEvidencePath =
      typeof entry.verificationEvidence === "string"
        ? entry.verificationEvidence
        : null;
    if (!storedEvidencePath) return { ...entry, verified: false };
    const evidencePath = evidencePathUnderRun(
      paths,
      run,
      scope,
      storedEvidencePath,
    );
    if (!evidencePath || !existsSync(evidencePath))
      return { ...entry, verified: false };
    try {
      const content = readFileSync(evidencePath, "utf8");
      const evidence = JSON.parse(content);
      const fileSha256 = sha256Text(content);
      if (
        !isHashBoundRouteEvidence({
          evidence,
          fileSha256,
          capability: rawEntry,
          recommendation,
          runId: run.id,
        })
      )
        return { ...entry, verified: false };
      return entry;
    } catch {
      return { ...entry, verified: false };
    }
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function exportManifestFiles(artifact: Record<string, unknown>): string[] {
  const manifest = nestedRecord(artifact, "exportManifest");
  const files = stringArray(manifest.files);
  if (files.length > 0) return files;
  const bundle = nestedRecord(artifact, "export");
  const bundleFiles = stringArray(bundle.files);
  return bundleFiles;
}

function readExportFiles(
  files: string[],
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  artifactDir: string,
):
  | {
      path: string;
      content: string;
      bytes: Buffer;
      symlinkTarget?: string | null;
    }[]
  | CliResult {
  const resolved: { path: string; absolute: string }[] = [];
  for (const file of files) {
    if (isAnyAbsolutePath(file))
      return fail(`Privacy preflight failed: ${file}: absolute private path.`);
    if (hasUnsafeRelativeParts(file))
      return fail(`Privacy preflight failed: ${file}: unsafe relative path.`);
    const absolute = storedPathToAbsolute(file, paths, scope, artifactDir);
    if (!absolute)
      return fail(
        `Privacy preflight failed: ${file}: path escapes skill-bench root.`,
      );
    resolved.push({ path: file, absolute });
  }
  const output: {
    path: string;
    content: string;
    bytes: Buffer;
    symlinkTarget?: string | null;
  }[] = [];
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(artifactRoot(paths, scope));
  } catch {
    return fail("Privacy preflight failed: skill-bench root cannot be verified.");
  }
  for (const file of resolved) {
    const opened = openRegularFile(file.absolute, constants.O_RDONLY);
    if (!opened.ok && opened.reason === "symlink") {
      output.push({
        path: file.path,
        content: "",
        bytes: Buffer.alloc(0),
        symlinkTarget: "unresolved",
      });
      continue;
    }
    if (!opened.ok && opened.reason === "missing")
      return fail(`Privacy preflight failed: ${file.path}: missing file.`);
    if (!opened.ok && opened.reason === "not-regular")
      return fail(`Privacy preflight failed: ${file.path}: not a file.`);
    if (!opened.ok)
      return fail(
        `Privacy preflight failed: ${file.path}: file cannot be opened safely.`,
      );
    try {
      if (opened.stat.nlink !== 1)
        return fail(
          `Privacy preflight failed: ${file.path}: hard-linked files are not portable.`,
        );
      const canonicalPath = realpathSync(file.absolute);
      if (!isPathInside(canonicalRoot, canonicalPath))
        return fail(
          `Privacy preflight failed: ${file.path}: symlink escapes skill-bench root.`,
        );
      const canonicalStat = statSync(canonicalPath);
      if (
        canonicalStat.dev !== opened.stat.dev ||
        canonicalStat.ino !== opened.stat.ino
      )
        return fail(
          `Privacy preflight failed: ${file.path}: file changed during verification.`,
        );
      const bytes = readFileSync(opened.fd);
      output.push({
        path: file.path,
        content: bytes.toString("utf8"),
        bytes,
        symlinkTarget: null,
      });
    } catch {
      return fail(
        `Privacy preflight failed: ${file.path}: file cannot be read safely.`,
      );
    } finally {
      closeSync(opened.fd);
    }
  }
  return output;
}

type PreparedPortableExport = {
  exportId: string;
  outputAbsolute: string;
  outputTrustedRoot: string;
  output: Record<string, unknown>;
  bundleText: string;
  bundleSha256: string;
  preview: Record<string, unknown>;
  previewPath: string;
  approvalLedgerPath: string;
  approvalSha256: string;
};

function preparePortableExport(input: {
  id: string;
  artifact: LoadedArtifact;
  paths: SkillBenchPaths;
  scope: SkillBenchScope;
  outputPath: string;
  cwd: string;
  exportFiles: Array<{ path: string; bytes: Buffer }>;
  preflightFiles: string[];
}): PreparedPortableExport | CliResult {
  const outputAbsolute = path.isAbsolute(input.outputPath)
    ? input.outputPath
    : path.resolve(input.cwd, input.outputPath);
  const outputTrustedRoot = path.isAbsolute(input.outputPath)
    ? path.parse(outputAbsolute).root
    : path.resolve(input.cwd);
  const bundledFiles = input.exportFiles.map((file) => ({
    path: file.path,
    encoding: "base64" as const,
    sizeBytes: file.bytes.length,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    content: file.bytes.toString("base64"),
  }));
  const sourceRelativePath = artifactRelativePath(
    input.paths,
    input.scope,
    input.artifact.path,
  );
  const bundledSourcePath = input.preflightFiles.find(
    (file) =>
      file === sourceRelativePath || file.endsWith(`/${sourceRelativePath}`),
  );
  if (!bundledSourcePath) {
    return fail(
      `Privacy preflight failed: ${input.id}: export manifest does not include its source artifact.`,
    );
  }
  const targetPathSha256 = sha256Text(outputAbsolute);
  const exportId = `export-${stableId({
    artifactKind: input.artifact.kind,
    id: input.id,
    scope: input.scope,
    targetPathSha256,
  })}`;
  const output = {
    schemaVersion: 1,
    phase: "export",
    exportId,
    id: input.id,
    artifactKind: input.artifact.kind,
    sourcePath: bundledSourcePath,
    sourceRelativePath,
    output: path.isAbsolute(input.outputPath)
      ? path.basename(input.outputPath)
      : input.outputPath,
    includedFiles: input.preflightFiles,
    privacyReview: "passed",
    bundleType: "skill-bench-json-v1",
    portable: true,
    files: bundledFiles,
    integrity: {
      algorithm: "sha256",
      sha256: sha256Json(bundledFiles),
    },
    tarball: false,
    published: false,
  };
  const bundleText = `${canonicalJson(output)}\n`;
  const bundleSha256 = sha256Text(bundleText);
  const artifactSha256 = createHash("sha256")
    .update(readFileSync(input.artifact.path))
    .digest("hex");
  const approvalBinding = {
    schemaVersion: 1,
    exportId,
    id: input.id,
    artifactKind: input.artifact.kind,
    sourceRelativePath,
    artifactSha256,
    targetPathSha256,
    bundleSha256,
    files: bundledFiles.map(({ path: filePath, sizeBytes, sha256 }) => ({
      path: filePath,
      sizeBytes,
      sha256,
    })),
  };
  const approvalSha256 = sha256Json(approvalBinding);
  const preview = {
    schemaVersion: 1,
    phase: "export-preview",
    exportId,
    id: input.id,
    artifactKind: input.artifact.kind,
    output: path.isAbsolute(input.outputPath)
      ? path.basename(input.outputPath)
      : input.outputPath,
    includedFiles: approvalBinding.files,
    redactions: [],
    privacyReview: "passed",
    bundleSha256,
    approvalSha256,
    approvalRequired: true,
    nextCommand: `omp skill-bench export ${input.id} --output ${JSON.stringify(input.outputPath)} --approve`,
  };
  const exportRoot = path.join(
    artifactRoot(input.paths, input.scope),
    "exports",
    exportId,
  );
  return {
    exportId,
    outputAbsolute,
    outputTrustedRoot,
    output,
    bundleText,
    bundleSha256,
    preview,
    previewPath: path.join(exportRoot, "plan.json"),
    approvalLedgerPath: path.join(exportRoot, "approvals.jsonl"),
    approvalSha256,
  };
}

function recordExportApproval(
  ledgerPath: string,
  trustedRoot: string,
  exportId: string,
  approvalSha256: string,
  id: string,
  artifactKind: ArtifactKind,
): CliResult | undefined {
  const opened = openRegularFile(
    ledgerPath,
    constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
    {
      rejectHardlinks: true,
      trustedRoot,
    },
  );
  if (!opened.ok)
    return fail(
      `Portable export ${exportId} ${approvalLedgerFailureReason(opened.reason)}.`,
    );
  try {
    let approved = false;
    for (const line of readFileSync(opened.fd, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as unknown;
      if (
        isRecord(event) &&
        event.type === "export-approval" &&
        event.exportId === exportId &&
        event.approvalSha256 === approvalSha256 &&
        event.approved === true
      ) {
        approved = true;
      }
    }
    if (!approved) {
      writeAllSync(
        opened.fd,
        `${canonicalJson({
          schemaVersion: 1,
          type: "export-approval",
          exportId,
          id,
          artifactKind,
          approvalSha256,
          approved: true,
          approvedAt: new Date().toISOString(),
        })}\n`,
      );
      fsyncSync(opened.fd);
    }
  } catch {
    return fail(`Portable export ${exportId} approval ledger is invalid.`);
  } finally {
    closeSync(opened.fd);
  }
  return undefined;
}

function writeJsonFile(
  filePath: string,
  value: unknown,
  trustedRoot: string,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeTrustedFile(filePath, `${canonicalJson(value)}\n`, trustedRoot);
}

type ManagedRouteRecord = RouteRule & {
  runId: string;
  recommendationId: string;
  recommendationSha256: string;
  fingerprintsSha256: string;
  capability: "advisory" | "enforced";
  instructionPath: string | null;
  instructionSha256: string | null;
};

function advisoryRouteInstructionPath(
  cwd: string,
  scope: RoutingScope,
): string {
  const copilotPaths = resolveCopilotPaths({ cwd });
  return scope === "project"
    ? copilotPaths.copilotInstructions
    : path.join(copilotPaths.userScope, "copilot-instructions.md");
}

function managedRoutingPath(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
): string {
  return resolveSkillBenchOutputPath(paths, scope, "routing.json");
}

function isManagedRouteRecord(value: unknown): value is ManagedRouteRecord {
  if (!isRecord(value)) return false;
  return (
    (value.scope === "project" || value.scope === "global") &&
    typeof value.taskMatcher === "string" &&
    value.taskMatcher.length > 0 &&
    typeof value.skillId === "string" &&
    value.skillId.length > 0 &&
    typeof value.modelId === "string" &&
    SAFE_MODEL_ID.test(value.modelId) &&
    typeof value.source === "string" &&
    typeof value.runId === "string" &&
    typeof value.recommendationId === "string" &&
    typeof value.recommendationSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.recommendationSha256) &&
    typeof value.fingerprintsSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprintsSha256) &&
    (value.capability === "advisory" || value.capability === "enforced") &&
    (value.instructionPath === null ||
      typeof value.instructionPath === "string") &&
    (value.instructionSha256 === null ||
      (typeof value.instructionSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.instructionSha256)))
  );
}

function readManagedRouteRecords(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
): ManagedRouteRecord[] {
  const statePath = managedRoutingPath(paths, scope);
  if (!existsSync(statePath)) return [];
  const state = loadJsonFile(
    statePath,
    path.dirname(path.dirname(artifactRoot(paths, scope))),
  );
  if (!isRecord(state) || state.schemaVersion !== 1) {
    throw new Error(`managed routing state is invalid: ${statePath}`);
  }
  const rules = Array.isArray(state.rules) ? state.rules : null;
  const integrity = nestedRecord(state, "integrity");
  if (
    !rules ||
    !rules.every(isManagedRouteRecord) ||
    rules.some((rule) => rule.scope !== scope) ||
    integrity.algorithm !== "sha256" ||
    integrity.sha256 !== sha256Json({ schemaVersion: 1, rules })
  ) {
    throw new Error(`managed routing state integrity failed: ${statePath}`);
  }
  return rules;
}

function uniqueRouteRules(rules: RouteRule[]): RouteRule[] {
  const unique = new Map<string, RouteRule>();
  for (const rule of rules) {
    const key = [
      rule.scope,
      rule.taskMatcher,
      rule.skillId,
      rule.modelId,
    ].join("\0");
    if (!unique.has(key)) unique.set(key, rule);
  }
  return [...unique.values()];
}

function currentRouteRules(input: {
  cwd: string;
  paths: SkillBenchPaths;
  scope: SkillBenchScope;
  artifactRules: RouteRule[];
}): RouteRule[] {
  const managed = readManagedRouteRecords(input.paths, input.scope);
  const instructionPath = advisoryRouteInstructionPath(input.cwd, input.scope);
  const instructionRule = existsSync(instructionPath)
    ? parseAdvisoryInstructionRoute(
        readFileSync(instructionPath, "utf8"),
        input.scope,
        `copilot-instructions:${displayPath(input.cwd, instructionPath)}`,
      )
    : null;
  return uniqueRouteRules([
    ...input.artifactRules,
    ...managed,
    ...(instructionRule ? [instructionRule] : []),
  ]);
}

function persistManagedRoute(input: {
  cwd: string;
  paths: SkillBenchPaths;
  scope: SkillBenchScope;
  recommendation: RoutingRecommendationV1;
  capability: "advisory" | "enforced";
  instructionPath: string | null;
}): string {
  const existing = readManagedRouteRecords(input.paths, input.scope);
  const instructionSha256 = input.instructionPath
    ? createHash("sha256")
        .update(readFileSync(input.instructionPath))
        .digest("hex")
    : null;
  const instructionPath = input.instructionPath
    ? input.scope === "project"
      ? displayPath(input.cwd, input.instructionPath)
      : "$COPILOT_HOME/copilot-instructions.md"
    : null;
  const rule: ManagedRouteRecord = {
    scope: input.scope,
    taskMatcher: input.recommendation.taskMatcher,
    skillId: input.recommendation.selectedSkill.id,
    modelId: input.recommendation.selectedModel.id,
    source:
      input.capability === "enforced"
        ? "skill-bench-enforced"
        : "skill-bench-advisory",
    runId: input.recommendation.runId,
    recommendationId: input.recommendation.id,
    recommendationSha256: sha256Json(input.recommendation),
    fingerprintsSha256: sha256Json(input.recommendation.fingerprints),
    capability: input.capability,
    instructionPath,
    instructionSha256,
  };
  const rules = [
    ...existing.filter(
      (existingRule) =>
        existingRule.taskMatcher !== rule.taskMatcher ||
        existingRule.scope !== rule.scope,
    ),
    rule,
  ].sort(
    (left, right) =>
      left.taskMatcher.localeCompare(right.taskMatcher) ||
      left.skillId.localeCompare(right.skillId) ||
      left.modelId.localeCompare(right.modelId),
  );
  const state = {
    schemaVersion: 1,
    rules,
    integrity: {
      algorithm: "sha256",
      sha256: sha256Json({ schemaVersion: 1, rules }),
    },
  };
  const statePath = writeSkillBenchJsonAtomic(
    input.paths,
    input.scope,
    "routing.json",
    state,
  );
  readManagedRouteRecords(input.paths, input.scope);
  return statePath;
}

function formatRouteConflicts(conflicts: RouteRule[]): string {
  return conflicts
    .map(
      (rule) =>
        `existing ${rule.scope} ${rule.taskMatcher} -> ${rule.skillId}@${rule.modelId} (${rule.source})`,
    )
    .join("; ");
}

function writeAdvisoryRouteInstructions(input: {
  cwd: string;
  scope: RoutingScope;
  recommendation: RoutingRecommendationV1;
}): string {
  const target = advisoryRouteInstructionPath(input.cwd, input.scope);
  const trustedRoot = path.dirname(path.dirname(target));
  mkdirSync(path.dirname(target), { recursive: true });
  const loaded = readRegularFileUtf8(target, trustedRoot);
  if (!loaded.ok && loaded.reason !== "missing")
    throw new Error(regularFileFailureReason(loaded.reason, "advisory instructions"));
  const existing = loaded.ok ? loaded.content : "";
  const next = renderAdvisoryInstructionBlock(input.recommendation, existing);
  if (next !== existing) {
    atomicWriteTrustedFile(target, next.endsWith("\n") ? next : `${next}\n`, {
      rejectHardlinks: true,
      trustedRoot,
    });
  }
  const persistedFile = readRegularFileUtf8(target, trustedRoot);
  if (!persistedFile.ok)
    throw new Error("skill-bench advisory instructions could not be rebound safely");
  const persisted = persistedFile.content;
  const expected = next.endsWith("\n") ? next : `${next}\n`;
  if (persisted !== expected) {
    throw new Error("skill-bench advisory instructions failed verification");
  }
  return target;
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function idFromRecordOrString(
  value: unknown,
  fallbackPrefix: string,
  index: number,
): string {
  if (typeof value === "string" && value) return value;
  if (isRecord(value)) {
    const id = stringFromAnyKey(value, [
      "id",
      "name",
      "modelId",
      "skillId",
      "label",
    ]);
    if (id) return id;
  }
  return `${fallbackPrefix}-${index + 1}`;
}

function specScenarios(
  artifact: Record<string, unknown>,
): Record<string, unknown>[] {
  const direct = recordsFrom(artifact.scenarios);
  if (direct.length > 0) return direct;
  const plan = nestedRecord(artifact, "scenarioPlan");
  const planned = recordsFrom(plan.scenarios);
  if (planned.length > 0) return planned;
  return [];
}

function specArms(artifact: Record<string, unknown>): string[] {
  const values = Array.isArray(artifact.arms)
    ? artifact.arms
    : Array.isArray(nestedRecord(artifact, "execution").arms)
      ? (nestedRecord(artifact, "execution").arms as unknown[])
      : [];
  return values.map((value, index) =>
    isRecord(value) && typeof value.kind === "string"
      ? value.kind
      : idFromRecordOrString(value, "arm", index),
  );
}

function approvedPromptArm(
  artifact: Record<string, unknown>,
): { approved: true; prompt: string } | null | CliResult {
  const arm = recordsFrom(artifact.arms).find((candidate) => candidate.kind === "prompt");
  if (!arm) return null;
  const prompt = stringFromAnyKey(arm, ["prompt", "guidance", "instructions"]);
  if (!prompt) {
    return fail(
      "Skill-bench provider run disabled: prompt arm requires frozen prompt guidance.",
    );
  }
  return { approved: true, prompt };
}

function specModels(artifact: Record<string, unknown>): string[] {
  const values = Array.isArray(artifact.models)
    ? artifact.models
    : Array.isArray(artifact.modelCandidates)
      ? artifact.modelCandidates
      : Array.isArray(artifact.candidateModelIds)
        ? artifact.candidateModelIds
        : Array.isArray(nestedRecord(artifact, "execution").models)
        ? (nestedRecord(artifact, "execution").models as unknown[])
        : [];
  return values.map((value, index) =>
    idFromRecordOrString(value, "model", index),
  );
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return [...duplicates];
}

function duplicateModelFailure(
  source: LoadedArtifact,
  mode: "pilot" | "validated",
  models: string[],
): CliResult | undefined {
  const duplicates = duplicateValues(models);
  return duplicates.length === 0
    ? undefined
    : fail(
        `Skill-bench ${mode} run disabled for ${source.id}: duplicate approved model ids: ${duplicates.join(", ")}. Remove duplicates and freeze a new reviewed spec before running.`,
      );
}

function syntheticExecutionEnabled(artifact: Record<string, unknown>): boolean {
  return (
    artifact.synthetic === true &&
    (process.env.NODE_ENV === "test" ||
      process.env.OMP_SKILL_BENCH_INTERNAL_SYNTHETIC === "1")
  );
}

function normalizedAllowlistedTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function validateReviewedManifestFreezeRequirements(
  id: string,
  artifact: Record<string, unknown>,
): CliResult | undefined {
  if (artifact.synthetic === true) return undefined;
  const provider = nestedRecord(artifact, "provider");
  if (provider.kind !== "copilot" || provider.approved !== true) {
    return fail(
      `Skill-bench draft ${id} cannot freeze non-synthetic reviewed manifest: approved provider transport required.`,
    );
  }
  const evaluation = nestedRecord(artifact, "evaluation");
  const command = Array.isArray(evaluation.command)
    ? evaluation.command.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : [];
  const evaluator = nestedRecord(evaluation, "evaluator");
  if (
    command.length === 0 ||
    evaluator.schemaVersion !== 1 ||
    typeof evaluator.path !== "string" ||
    typeof evaluator.sha256 !== "string" ||
    typeof evaluator.provenance !== "string"
  ) {
    return fail(
      `Skill-bench draft ${id} cannot freeze non-synthetic reviewed manifest: frozen evaluator descriptor required.`,
    );
  }
  const execution = nestedRecord(artifact, "execution");
  const allowlistedTools = normalizedAllowlistedTools(execution.allowlistedTools);
  const fallbackAllowlistedTools = normalizedAllowlistedTools(artifact.allowlistedTools);
  if (allowlistedTools.length === 0 && fallbackAllowlistedTools.length === 0) {
    return fail(
      `Skill-bench draft ${id} cannot freeze non-synthetic reviewed manifest: explicit non-empty allowlistedTools required before freeze.`,
    );
  }
  const budgets = nestedRecord(artifact, "budgets");
  const estimatedCellUsd = budgets.estimatedCellUsd;
  const estimatedCellPremiumRequests = budgets.estimatedCellPremiumRequests;
  if (
    typeof estimatedCellUsd !== "number" ||
    !Number.isFinite(estimatedCellUsd) ||
    estimatedCellUsd < 0 ||
    typeof estimatedCellPremiumRequests !== "number" ||
    !Number.isFinite(estimatedCellPremiumRequests) ||
    estimatedCellPremiumRequests < 0
  ) {
    return fail(
      `Skill-bench draft ${id} cannot freeze non-synthetic reviewed manifest: approved conservative per-cell estimates required before freeze.`,
    );
  }
  const hardCeilings = [
    ["maxUsd", budgets.maxUsd],
    ["maxCells", budgets.maxCells],
    ["maxRuntimeMs", budgets.maxRuntimeMs],
    ["maxPremiumRequests", budgets.maxPremiumRequests],
  ] as const;
  if (
    hardCeilings.some(([, value]) =>
      typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  ) {
    return fail(
      `Skill-bench draft ${id} cannot freeze non-synthetic reviewed manifest: explicit hard budget ceilings required before freeze.`,
    );
  }
  return undefined;
}

function fingerprintValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function frozenEvaluator(
  artifact: Record<string, unknown>,
  artifactPath: string,
): { argv: string[]; evaluator: FrozenEvaluatorDescriptorV1 } | CliResult {
  const evaluation = nestedRecord(artifact, "evaluation");
  const command = Array.isArray(evaluation.command) ? evaluation.command.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  const evaluator = nestedRecord(evaluation, "evaluator");
  if (command.length === 0 || evaluator.schemaVersion !== 1 || typeof evaluator.path !== "string" || typeof evaluator.sha256 !== "string" || typeof evaluator.provenance !== "string")
    return fail("Skill-bench provider run disabled: frozen evaluator descriptor required.");
  const bundleRoot = path.dirname(artifactPath);
  const evaluatorPath = path.isAbsolute(evaluator.path)
    ? path.resolve(evaluator.path)
    : path.resolve(bundleRoot, evaluator.path);
  const approvedRoot =
    typeof evaluator.approvedRoot === "string"
      ? path.isAbsolute(evaluator.approvedRoot)
        ? path.resolve(evaluator.approvedRoot)
        : path.resolve(bundleRoot, evaluator.approvedRoot)
      : bundleRoot;
  const normalizedCommand = command.map((entry, index) => {
    if (entry === evaluator.path) return evaluatorPath;
    if (index === 0 && entry === "node") return process.execPath;
    return entry;
  });
  if (!normalizedCommand.includes(evaluatorPath)) {
    return fail("Skill-bench provider run disabled: evaluator command is not bound to the frozen evaluator.");
  }
  return {
    argv: normalizedCommand,
    evaluator: {
      ...(evaluator as unknown as FrozenEvaluatorDescriptorV1),
      path: evaluatorPath,
      approvedRoot,
    },
  };
}

type SyntheticCellEvidence = {
  scenarioId: string;
  modelId: string;
  arm: string;
  cellId: string;
  cellRelative: string;
  proofMatrix: {
    expected: string[];
    found: string[];
    done: string[];
    missed: string[];
    falsePositive: string[];
    incorrect: string[];
    proof: string[];
  };
  qualityScore: number;
};

function resolveSyntheticCellEvidence(
  artifact: Record<string, unknown>,
  scenarios: Record<string, unknown>[],
  arms: string[],
  models: string[],
  runRelativeRoot: string,
): SyntheticCellEvidence[] | { ok: false; message: string } {
  const evidenceSource = Array.isArray(artifact.cellResults)
    ? artifact.cellResults
    : Array.isArray(artifact.deterministicEvaluatorResults)
      ? artifact.deterministicEvaluatorResults
      : null;
  if (!evidenceSource)
    return {
      ok: false,
      message:
        "synthetic execution requires explicit deterministicEvaluatorResults or cellResults evidence",
    };

  const byKey = new Map<string, Record<string, unknown>>();
  for (const entry of evidenceSource) {
    if (!isRecord(entry))
      return { ok: false, message: "synthetic cell evidence entries must be objects" };
    const scenarioId = stringField(entry, "scenarioId");
    const modelId = stringField(entry, "modelId");
    const arm = stringField(entry, "arm");
    if (!scenarioId || !modelId || !arm)
      return {
        ok: false,
        message:
          "synthetic cell evidence requires scenarioId, modelId, and arm",
      };
    const key = syntheticCellKey(scenarioId, modelId, arm);
    if (byKey.has(key))
      return { ok: false, message: `duplicate synthetic cell evidence: ${key}` };
    byKey.set(key, entry);
  }

  const cells: SyntheticCellEvidence[] = [];
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const scenarioId = idFromRecordOrString(scenario, "scenario", scenarioIndex);
    for (const modelId of models) {
      for (const arm of arms) {
        const key = syntheticCellKey(scenarioId, modelId, arm);
        const entry = byKey.get(key);
        if (!entry)
          return { ok: false, message: `missing synthetic cell evidence: ${key}` };
        const qualityScore = entry.qualityScore;
        if (typeof qualityScore !== "number" || !Number.isFinite(qualityScore))
          return { ok: false, message: `invalid synthetic qualityScore: ${key}` };
        const proofMatrix = normalizeSyntheticProofMatrix(
          entry.proofMatrix,
          scenario,
          key,
        );
        if ("ok" in proofMatrix) return proofMatrix;
        const cellId = `${safeCellPart(scenarioId)}-${safeCellPart(modelId)}-${safeCellPart(arm)}`;
        const cellRelative = path.posix.join(runRelativeRoot, "cells", cellId);
        cells.push({
          scenarioId,
          modelId,
          arm,
          cellId,
          cellRelative,
          proofMatrix: {
            ...proofMatrix,
            proof:
              proofMatrix.proof.length > 0
                ? proofMatrix.proof
                : [`${cellRelative}/scorer.json`],
          },
          qualityScore,
        });
      }
    }
  }
  return cells;
}

function syntheticCellKey(scenarioId: string, modelId: string, arm: string): string {
  return `${scenarioId}\0${modelId}\0${arm}`;
}

function normalizeSyntheticProofMatrix(
  value: unknown,
  scenario: Record<string, unknown>,
  key: string,
): SyntheticCellEvidence["proofMatrix"] | { ok: false; message: string } {
  if (!isRecord(value))
    return { ok: false, message: `missing synthetic proofMatrix: ${key}` };
  const expected = stringArray(value.expected);
  const fallbackExpected =
    stringArray(scenario.expected).length > 0
      ? stringArray(scenario.expected)
      : [String(scenario.title ?? key)];
  return {
    expected: expected.length > 0 ? expected : fallbackExpected,
    found: stringArray(value.found),
    done: stringArray(value.done),
    missed: stringArray(value.missed),
    falsePositive: stringArray(value.falsePositive),
    incorrect: stringArray(value.incorrect),
    proof: stringArray(value.proof),
  };
}

function buildSyntheticRun(
  source: LoadedArtifact,
  mode: "pilot" | "validated",
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cwd: string,
): CliResult {
  if (!syntheticExecutionEnabled(source.artifact))
    return writeBlockedPreflight(source, mode, paths, scope, cwd);
  const scenarios = specScenarios(source.artifact);
  const arms = specArms(source.artifact);
  const models = specModels(source.artifact);
  const promptArm = approvedPromptArm(source.artifact);
  if (promptArm && "ok" in promptArm) return promptArm;
  if (scenarios.length === 0)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec has no scenarios.`,
    );
  if (!arms.includes("baseline") || !arms.includes("skill"))
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec must declare matched baseline and skill arms.`,
    );
  if (models.length === 0)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec has no models.`,
    );
  const duplicateModels = duplicateModelFailure(source, mode, models);
  if (duplicateModels) return duplicateModels;

  const fingerprint = nestedRecord(source.artifact, "fingerprint");
  const skill = nestedRecord(source.artifact, "skill");
  const runId = `${mode}-${source.id}-${stableId({ source: source.artifact, sourcePath: source.path, mode, synthetic: true })}`;
  const runRelativeRoot = path.posix.join("runs", runId);
  const runRoot = path.join(artifactRoot(paths, scope), "runs", runId);
  const cellEvidence = resolveSyntheticCellEvidence(
    source.artifact,
    scenarios,
    arms,
    models,
    runRelativeRoot,
  );
  if ("ok" in cellEvidence)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: ${cellEvidence.message}.`,
    );
  const cells = cellEvidence;
  let sourceApproval: { specContentHash: string; ledgerSha256: string };
  try {
    const reservedRunRoot = reserveSkillBenchArtifactRoot(
      paths,
      scope,
      runRelativeRoot,
      "run",
      runId,
    );
    if (reservedRunRoot !== runRoot)
      throw new Error("run output reservation resolved to an unexpected path");
    sourceApproval = persistRunApprovalProof(
      source,
      runRoot,
      scopeBaseFromPaths(paths, scope),
    );
  } catch (error) {
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: run output could not be reserved safely: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  const evidenceBundles = cells.map((cell) => {
    const bundle = writeSyntheticCell(paths, scope, cell.cellRelative, {
      request: {
        schemaVersion: 1,
        runId,
        scenarioId: cell.scenarioId,
        modelId: cell.modelId,
        arm: cell.arm,
        provider: "synthetic",
        zeroSpend: true,
      },
      response: {
        schemaVersion: 1,
        status: "complete",
        output:
          cell.arm === "skill" ? stringArray(cell.proofMatrix.done).join("\n") : "",
        synthetic: true,
      },
      result: {
        schemaVersion: 1,
        status: "complete",
        qualityScore: cell.qualityScore,
        deterministic: true,
      },
      scorer: {
        schemaVersion: 1,
        status: "complete",
        proofMatrix: cell.proofMatrix,
      },
      usage: {
        schemaVersion: 1,
        inputTokens: null,
        outputTokens: null,
        costUsd: 0,
        premiumRequests: 0,
        completeness: "synthetic-zero-spend",
        provenance: "local-synthetic",
      },
      timestamps: {
        schemaVersion: 1,
        startedAt: "synthetic",
        completedAt: "synthetic",
        durationMs: 0,
      },
    });
    return { cellId: cell.cellId, ...bundle };
  });
  const incompleteEvidence = evidenceBundles.filter(
    (bundle) => bundle.status !== "complete",
  );

  const skillId = fingerprintValue(
    stringFromAnyKey(skill, ["id", "name"]),
    fingerprintValue(source.artifact.skillId, source.id),
  );
  const skillFp = fingerprintValue(
    fingerprint.skill,
    stableId({ skillId, source: source.id }),
  );
  const modelFp = fingerprintValue(fingerprint.model, stableId({ models }));
  const specFp = fingerprintValue(fingerprint.spec, stableId(source.artifact));
  const evalFp = fingerprintValue(
    fingerprint.evaluation,
    stableId(nestedRecord(source.artifact, "evaluation")),
  );
  const providerFp = fingerprintValue(
    fingerprint.provider,
    stableId({ provider: "synthetic" }),
  );
  const syntheticBudgets = nestedRecord(source.artifact, "budgets");
  const confidence = buildRunConfidence(mode, runId, cells, {
    specHash: specContentHash(source.artifact),
    armIds: arms,
    scenarios,
    approvedMaximumMatchedUnits: Math.floor(
      numberFrom(syntheticBudgets.maxCells, cells.length) / arms.length,
    ),
  });
  const reportInput: SkillBenchReportInput = {
    schemaVersion: 1,
    runId,
    mode,
    status: "completed",
    spec: {
      id: source.id,
      fingerprint: specFp,
      evaluationFingerprint: evalFp,
      seed: `synthetic-${stableId(source.artifact)}`,
      rerunCommand: `omp skill-bench rerun ${runId}`,
    },
    skill: { id: skillId, fingerprint: skillFp },
    model: {
      id: models.length === 1 ? models[0] : "multiple-approved-models",
      fingerprint: modelFp,
    },
    environment: { provider: "synthetic", fingerprint: providerFp },
    pricing: { source: "synthetic", currency: "USD", completeness: "complete" },
    budget: { maxUsd: 0, spentUsd: 0, premiumRequests: 0, cells: cells.length },
    warnings:
      mode === "pilot" ? ["pilot mode does not emit a validated winner"] : [],
    confidence,
    cells: cells.map((cell) => ({
      id: cell.cellId,
      taskId: cell.scenarioId,
      arm: cell.arm,
      modelId: cell.modelId,
      status: "complete",
      hardGatesPassed: true,
      qualityPassed:
        cell.qualityScore >=
        scenarioQualityPassThreshold(
          scenarios.find((scenario) => scenario.id === cell.scenarioId) ?? {},
        ),
      qualityScore: cell.qualityScore,
      costUsd: 0,
      latencyMs: 0,
      samples: 1,
      scenariosCovered: 1,
      scenariosRequired: 1,
      proofMatrix: cell.proofMatrix,
      evidencePaths: REQUIRED_EVIDENCE_ARTIFACTS.map(
        (artifact) => `${cell.cellRelative}/${artifact}`,
      ),
      tokens: {
        completeness: "synthetic-zero-spend",
        provenance: "local-synthetic",
      },
    })),
  };
  const reportView = normalizeSkillBenchReport(reportInput);
  const recommendationTarget =
    mode === "validated" && reportView.decision.validated
      ? selectRecommendationTarget(reportView, source.artifact)
      : null;
  reportView.decision.recommendedRoute = recommendationTarget
    ? {
        skillId,
        modelId: recommendationTarget.modelId,
        objective: recommendationTarget.objective,
      }
    : null;
  const recommendation =
    mode === "validated" && reportView.decision.validated && recommendationTarget
      ? ({
          schemaVersion: 1,
          id: `rec-${runId}`,
          runId,
          action: "advisory",
          status: "ready",
          validated: true,
          humanApprovedPolicy: null,
          scope,
          taskMatcher: fingerprintValue(source.artifact.taskMatcher, source.id),
          objective: recommendationTarget.objective,
          selectedSkill: { id: skillId, fingerprint: skillFp },
          selectedModel: { id: recommendationTarget.modelId, fingerprint: modelFp },
          fingerprints: {
            spec: specFp,
            evaluation: evalFp,
            provider: providerFp,
          },
          confidence: {
            verdict: reportView.decision.confidence.verdict,
            samples: reportView.decision.confidence.sampleCount,
            scenarioCoverage: reportView.decision.coverage.scenarioCoverage,
          },
          evidencePath: `${runRelativeRoot}/summary.json`,
        } satisfies RoutingRecommendationV1 & { action: string; status: string })
      : null;
  const summary = {
    schemaVersion: 1,
    runId,
    mode,
    status: "completed",
    synthetic: true,
    zeroSpend: true,
    cells: cells.length,
    scenarios: scenarios.length,
    arms,
    models,
  };
  const runArtifact = {
    schemaVersion: 1,
    id: runId,
    sourceId: source.id,
    sourceKind: source.kind,
    sourcePath: safeSourceReference(paths, scope, source),
    sourceFingerprint: stableId(source.artifact),
    sourceApproval,
    mode,
    status: "completed",
    synthetic: true,
    zeroSpend: true,
    approvals: nestedRecord(source.artifact, "approvals"),
    fingerprint: { status: "current" },
    currentFingerprints: {
      skill: skillFp,
      model: modelFp,
      spec: specFp,
      evaluation: evalFp,
      provider: providerFp,
    },
    conflicts: { status: "clear" },
    evidence:
      incompleteEvidence.length === 0
        ? { status: "verified" }
        : { status: "incomplete-evidence", missingBundles: incompleteEvidence },
    recommendation: recommendation ?? undefined,
    routingCapabilities: copilotAdvisoryCapabilities(recommendation),
    reportPath: `${runRelativeRoot}/sweep_report.html`,
    reportInput,
    reportView,
    summaryPath: `${runRelativeRoot}/summary.json`,
    exportManifest: {
      files: [
        `${runRelativeRoot}/run.json`,
        `${runRelativeRoot}/approvals.jsonl`,
        `${runRelativeRoot}/summary.json`,
        ...(recommendation
          ? [`${runRelativeRoot}/recommendation.json`]
          : []),
        `${runRelativeRoot}/sweep_report.html`,
        ...reportInput.cells.flatMap((cell) => [
          ...cell.evidencePaths,
          `${path.posix.dirname(cell.evidencePaths[0] ?? `${runRelativeRoot}/cells/${cell.id}/request.json`)}/COMPLETE`,
        ]),
      ],
    },
  };
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(runRelativeRoot, "summary.json"),
    summary,
  );
  if (recommendation)
    writeSkillBenchJsonAtomic(
      paths,
      scope,
      path.posix.join(runRelativeRoot, "recommendation.json"),
      recommendation,
    );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(runRelativeRoot, "run.json"),
    runArtifact,
  );
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(runRelativeRoot, "sweep_report.html"),
    renderSkillBenchReportHtml(reportView),
  );
  const output = {
    schemaVersion: 1,
    phase: "run",
    id: runId,
    sourceId: source.id,
    mode,
    status: "completed",
    synthetic: true,
    zeroSpend: true,
    cells: cells.length,
    runPath: displayPath(cwd, path.join(runRoot, "run.json")),
    reportPath: displayPath(cwd, path.join(runRoot, "sweep_report.html")),
  };
  return {
    ok: true,
    output,
    message: `${mode} synthetic run completed for ${source.id}\nrun-id=${runId}\ncells=${cells.length}\nrun: ${output.runPath}\nreport: ${output.reportPath}\nzero-spend=true`,
  };
}

type RecommendationObjective =
  | "quality-first"
  | "quality-max"
  | "cost-min"
  | "latency-min"
  | "balanced";

function selectRecommendationTarget(
  report: SkillBenchReportView,
  artifact: Record<string, unknown>,
): { modelId: string; objective: RecommendationObjective } | null {
  const rawObjective = artifact.routingObjective;
  const objectiveRecord = isRecord(rawObjective) ? rawObjective : {};
  const rawKind =
    typeof rawObjective === "string"
      ? rawObjective
      : stringFromAnyKey(objectiveRecord, ["kind", "id", "mode"]);
  const objective = (rawKind ?? "quality-first") as RecommendationObjective;
  if (
    ![
      "quality-first",
      "quality-max",
      "cost-min",
      "latency-min",
      "balanced",
    ].includes(objective)
  ) {
    return null;
  }

  const rows = report.rows.filter(
    (row) =>
      row.arm === "skill" &&
      row.status === "complete" &&
      row.hardGatesPassed &&
      row.qualityPassed,
  );
  const requiredTasks = new Set(report.rows.map((row) => row.taskId)).size;
  const byModel = new Map<string, typeof rows>();
  for (const row of rows) {
    const modelRows = byModel.get(row.modelId) ?? [];
    modelRows.push(row);
    byModel.set(row.modelId, modelRows);
  }
  const candidates = [...byModel.entries()].flatMap(([modelId, modelRows]) => {
    if (new Set(modelRows.map((row) => row.taskId)).size !== requiredTasks) return [];
    const costs = modelRows.map((row) => row.costUsd);
    const latencies = modelRows.map((row) => row.latencyMs);
    return [{
      modelId,
      quality:
        modelRows.reduce((sum, row) => sum + row.qualityScore, 0) /
        modelRows.length,
      cost:
        costs.every((value): value is number => typeof value === "number" && Number.isFinite(value))
          ? costs.reduce((sum, value) => sum + value, 0)
          : null,
      latency:
        latencies.every((value): value is number => typeof value === "number" && Number.isFinite(value))
          ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
          : null,
    }];
  });
  if (candidates.length === 0) return null;

  const known = (value: number | null): number =>
    value === null ? Number.POSITIVE_INFINITY : value;
  if (objective === "cost-min") {
    if (candidates.every((candidate) => candidate.cost === null)) return null;
    candidates.sort(
      (a, b) =>
        known(a.cost) - known(b.cost) ||
        b.quality - a.quality ||
        known(a.latency) - known(b.latency) ||
        a.modelId.localeCompare(b.modelId),
    );
  } else if (objective === "latency-min") {
    if (candidates.every((candidate) => candidate.latency === null)) return null;
    candidates.sort(
      (a, b) =>
        known(a.latency) - known(b.latency) ||
        b.quality - a.quality ||
        known(a.cost) - known(b.cost) ||
        a.modelId.localeCompare(b.modelId),
    );
  } else if (objective === "balanced") {
    const weights = nestedRecord(objectiveRecord, "weights");
    const qualityWeight = weights.quality;
    const costWeight = weights.cost;
    const latencyWeight = weights.latency;
    if (
      !isNonNegativeNumber(qualityWeight) ||
      !isNonNegativeNumber(costWeight) ||
      !isNonNegativeNumber(latencyWeight) ||
      qualityWeight + costWeight + latencyWeight <= 0 ||
      (costWeight > 0 && candidates.some((candidate) => candidate.cost === null)) ||
      (latencyWeight > 0 && candidates.some((candidate) => candidate.latency === null))
    ) {
      return null;
    }
    const normalize = (
      value: number,
      values: number[],
      lowerIsBetter: boolean,
    ): number => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max === min) return 1;
      const scaled = (value - min) / (max - min);
      return lowerIsBetter ? 1 - scaled : scaled;
    };
    const qualities = candidates.map((candidate) => candidate.quality);
    const costs = candidates.map((candidate) => candidate.cost ?? 0);
    const latencies = candidates.map((candidate) => candidate.latency ?? 0);
    candidates.sort((a, b) => {
      const score = (candidate: (typeof candidates)[number]): number =>
        qualityWeight * normalize(candidate.quality, qualities, false) +
        costWeight * normalize(candidate.cost ?? 0, costs, true) +
        latencyWeight * normalize(candidate.latency ?? 0, latencies, true);
      return score(b) - score(a) || a.modelId.localeCompare(b.modelId);
    });
  } else {
    candidates.sort(
      (a, b) =>
        b.quality - a.quality ||
        known(a.cost) - known(b.cost) ||
        known(a.latency) - known(b.latency) ||
        a.modelId.localeCompare(b.modelId),
    );
  }
  return { modelId: candidates[0].modelId, objective };
}

function buildRunConfidence(
  mode: "pilot" | "validated",
  runId: string,
  cells: Array<{
    scenarioId: string;
    modelId: string;
    arm: string;
    qualityScore: number;
    status?: string;
    hardGatesPassed?: boolean;
  }>,
  options: {
    specHash: string;
    armIds: string[];
    scenarios: Record<string, unknown>[];
    approvedMaximumMatchedUnits?: number;
  },
): SkillBenchReportInput["confidence"] {
  if (mode === "pilot") return undefined;
  const comparisonFamily = freezeComparisonFamily({
    comparisonFamilyId: runId,
    armIds: options.armIds,
  });
  const completed = cells.filter(
    (cell) => cell.status === undefined ||
      (cell.status === "complete" && cell.hardGatesPassed !== false),
  );
  const skillCells = completed.filter((cell) => cell.arm === "skill");
  const rivalArms = [...new Set(options.armIds)].filter(
    (arm) => arm !== "skill",
  );
  const comparisons = rivalArms.flatMap((rivalArm) => {
    const differences = skillCells.flatMap((skillCell) => {
      const rival = completed.find(
        (cell) =>
          cell.arm === rivalArm &&
          cell.scenarioId === skillCell.scenarioId &&
          cell.modelId === skillCell.modelId,
      );
      return rival ? [skillCell.qualityScore - rival.qualityScore] : [];
    });
    if (differences.length === 0) return [];
    const comparisonId = [rivalArm, "skill"].sort().join("__");
    return [
      comparePairedDifferences({
        comparisonId,
        comparisonFamily,
        differences,
        maxLooks: 1,
        currentLook: 1,
        resamples: PROTOCOL_BOOTSTRAP_RESAMPLES,
        seed: `${options.specHash}:${comparisonId}`,
      }),
    ];
  });
  const primary =
    comparisons.find((comparison) => comparison.comparisonId === "baseline__skill") ??
    comparisons[0];
  if (!primary) return undefined;

  const scenariosById = new Map(
    options.scenarios.map((scenario) => [
      stringFromAnyKey(scenario, ["id"]) ?? "",
      stringArray(scenario.tags),
    ]),
  );
  const requiredScenarioFamilies = [
    ...new Set(options.scenarios.flatMap((scenario) => stringArray(scenario.tags))),
  ];
  const scenarioFamilyCounts: Record<string, number> = {};
  for (const skillCell of skillCells) {
    const baseline = completed.find(
      (cell) =>
        cell.arm === "baseline" &&
        cell.scenarioId === skillCell.scenarioId &&
        cell.modelId === skillCell.modelId,
    );
    if (!baseline) continue;
    for (const family of scenariosById.get(skillCell.scenarioId) ?? []) {
      scenarioFamilyCounts[family] = (scenarioFamilyCounts[family] ?? 0) + 1;
    }
  }
  const decision = decideValidatedSampling({
    matchedUnits: primary.metadata.sampleCount,
    approvedMaximumMatchedUnits: options.approvedMaximumMatchedUnits,
    scenarioFamilyCounts,
    requiredScenarioFamilies,
    comparisonResults:
      comparisons.length === rivalArms.length ? comparisons : [],
    exhausted: true,
  });
  const verdict =
    decision.status === "winner" || decision.status === "tie"
      ? decision.status
      : "inconclusive";
  return {
    verdict,
    noWinnerReason:
      verdict === "winner"
        ? null
        : verdict === "tie"
          ? "validated practical tie"
          : `${decision.stopReason ?? "exhaustion"}: ${decision.evidenceGate}`,
    interval: {
      lower: primary.lower,
      mean: primary.mean,
      upper: primary.upper,
    },
    metadata: primary.metadata,
  };
}

function safeCellPart(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "cell"
  );
}

function writeSyntheticCell(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cellRelative: string,
  artifacts: {
    request: unknown;
    response: unknown;
    result: unknown;
    scorer: unknown;
    usage: unknown;
    timestamps: unknown;
  },
): { status: "complete" | "incomplete-evidence"; missingArtifacts: string[] } {
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "request.json"),
    artifacts.request,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "response.json"),
    artifacts.response,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "result.json"),
    artifacts.result,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "scorer.json"),
    artifacts.scorer,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "usage.json"),
    artifacts.usage,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "timestamps.json"),
    artifacts.timestamps,
  );
  const cellRoot = path.join(
    artifactRoot(paths, scope),
    ...cellRelative.split("/"),
  );
  writeSkillBenchFileAtomic(paths, scope, path.posix.join(cellRelative, "diff.patch"), "");
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "tests.txt"),
    "synthetic tests passed\n",
  );
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "transcript.txt"),
    `${canonicalJson({ event: "synthetic", status: "complete" })}\n`,
  );
  return finalizeEvidenceBundle(cellRoot, scopeBaseFromPaths(paths, scope));
}

function writeBlockedPreflight(
  source: LoadedArtifact,
  mode: "pilot" | "validated",
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cwd: string,
): CliResult {
  const preflightId = `${mode}-${source.id}-${stableId({ source: source.id, sourcePath: source.path, mode, fingerprint: nestedRecord(source.artifact, "fingerprint"), status: "preflight" })}`;
  const preflightRelative = path.posix.join(
    "preflights",
    preflightId,
    "preflight.json",
  );
  const preflightPath = path.join(
    artifactRoot(paths, scope),
    ...preflightRelative.split("/"),
  );
  const output = {
    schemaVersion: 1,
    phase: "preflight",
    id: preflightId,
    sourceId: source.id,
    sourceKind: source.kind,
    sourcePath: safeSourceReference(paths, scope, source),
    sourceFingerprint: stableId(source.artifact),
    mode,
    status: "blocked",
    disabledReason:
      "live provider execution requires explicit approval outside this local command path",
    approvals: nestedRecord(source.artifact, "approvals"),
    fingerprint: nestedRecord(source.artifact, "fingerprint"),
    gates: {
      frozenApprovalRequired: true,
      budgetApprovalRequired: true,
      executionEngineRequired: true,
      liveCellApprovalRequiredBeforeExecution: true,
    },
    preflightPath: displayPath(cwd, preflightPath),
    next: {
      execute:
        "rerun with a synthetic/local approved spec or explicit live-provider approval",
    },
  };
  const persistedPath = writeSkillBenchJsonAtomic(
    paths,
    scope,
    preflightRelative,
    output,
  );
  const persistedOutput = {
    ...output,
    preflightPath: displayPath(cwd, persistedPath),
  };
  return fail(
    `${mode} run not scheduled for ${source.id}: live provider execution requires explicit approval.\npreflight-id=${preflightId}\npreflight: ${persistedOutput.preflightPath}\nstatus=blocked\nno benchmark cells were queued or executed`,
  );
}

async function buildProviderRun(
  source: LoadedArtifact,
  mode: "pilot" | "validated",
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cwd: string,
  approveSpend: boolean,
): Promise<CliResult> {
  let approvals = nestedRecord(source.artifact, "approvals");
  const recordedSpendApproval = liveSpendApprovalStatus(source);
  if (isCliFailure(recordedSpendApproval)) return recordedSpendApproval;
  if (!recordedSpendApproval.approved && !approveSpend)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: live-cell approval required; rerun with --approve-spend after reviewing the frozen spec and budget.`,
    );
  const provider = nestedRecord(source.artifact, "provider");
  if (provider.kind !== "copilot" || provider.approved !== true)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved provider transport required.`,
    );
  if (!["restricted", "normal-project", "custom"].includes(String(source.artifact.executionProfile)))
    return fail(`Skill-bench ${mode} run disabled for ${source.id}: unsupported execution profile before spend.`);
  const executionProfile = providerExecutionProfile(source.artifact);
  if ("ok" in executionProfile) return executionProfile;
  const evaluator = frozenEvaluator(source.artifact, source.path);
  if ("ok" in evaluator) return evaluator;
  const embeddedPublicPricing = approvedPublicPricing(source.artifact);
  if (embeddedPublicPricing && "ok" in embeddedPublicPricing)
    return embeddedPublicPricing;
  const scenarios = specScenarios(source.artifact);
  const arms = specArms(source.artifact);
  const models = specModels(source.artifact);
  const promptArm = approvedPromptArm(source.artifact);
  if (promptArm && "ok" in promptArm) return promptArm;
  if (scenarios.length === 0)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec has no scenarios.`,
    );
  if (!arms.includes("baseline") || !arms.includes("skill"))
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec must declare matched baseline and skill arms.`,
    );
  if (models.length === 0)
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: approved spec has no models.`,
    );
  const duplicateModels = duplicateModelFailure(source, mode, models);
  if (duplicateModels) return duplicateModels;

  const fingerprint = nestedRecord(source.artifact, "fingerprint");
  const skill = nestedRecord(source.artifact, "skill");
  const skillId = fingerprintValue(
    stringFromAnyKey(skill, ["name", "slug", "id"]),
    skillIdFromArms(source.artifact) ?? source.id,
  );
  const storedSkillSourcePath = stringFromAnyKey(skill, ["path", "canonicalPath", "sourcePath"]);
  const skillSourcePath = storedSkillSourcePath
    ? path.isAbsolute(storedSkillSourcePath)
      ? storedSkillSourcePath
      : path.resolve(path.dirname(source.path), storedSkillSourcePath)
    : null;
  const frozenSkillFingerprint = stringFromAnyKey(skill, ["fingerprint"]);
  if (!skillSourcePath || !frozenSkillFingerprint)
    return fail(`Skill-bench ${mode} run disabled for ${source.id}: frozen skill source path and fingerprint required.`);
  if (!existsSync(skillSourcePath) || !lstatSync(skillSourcePath).isDirectory())
    return fail(`Skill-bench ${mode} run disabled for ${source.id}: frozen skill source path is missing.`);
  try {
    const currentSkillFingerprint = fingerprintSkillDirectory(
      realpathSync(skillSourcePath),
    );
    if (currentSkillFingerprint !== frozenSkillFingerprint)
      return fail(`Skill-bench ${mode} run disabled for ${source.id}: frozen skill fingerprint is stale.`);
    if (
      typeof fingerprint.skill === "string" &&
      fingerprint.skill !== frozenSkillFingerprint
    )
      return fail(`Skill-bench ${mode} run disabled for ${source.id}: skill fingerprint binding mismatch.`);
  } catch (error) {
    return fail(`Skill-bench ${mode} run disabled for ${source.id}: frozen skill source cannot be verified: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const budgets = nestedRecord(source.artifact, "budgets");
  const ceilings = {
    maxUsd: numberFrom(budgets.maxUsd, 1),
    maxPremiumRequests: numberFrom(budgets.maxPremiumRequests, 50),
    maxRuntimeMs: runtimeCeilingMs(budgets),
    maxCells: numberFrom(budgets.maxCells, 100),
  };
  if (
    mode === "validated" &&
    Math.floor(ceilings.maxCells / arms.length) <
      PROTOCOL_MINIMUM_MATCHED_UNITS
  ) {
    return fail(
      `Skill-bench validated run disabled for ${source.id}: approved cell budget cannot satisfy ${PROTOCOL_MINIMUM_MATCHED_UNITS} complete matched units.`,
    );
  }
  const estimatedCellUsd = budgets.estimatedCellUsd;
  const estimatedCellPremiumRequests = budgets.estimatedCellPremiumRequests;
  if (
    typeof estimatedCellUsd !== "number" ||
    !Number.isFinite(estimatedCellUsd) ||
    estimatedCellUsd < 0 ||
    typeof estimatedCellPremiumRequests !== "number" ||
    !Number.isFinite(estimatedCellPremiumRequests) ||
    estimatedCellPremiumRequests < 0
  )
    return fail(`Skill-bench ${mode} run disabled for ${source.id}: approved conservative per-cell estimates required before scheduling.`);
  const evaluatorPreflight = await preflightProviderEvaluator(
    evaluator,
    source.id,
  );
  if (evaluatorPreflight.status !== "ok") {
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: evaluator contract preflight failed before provider spend: ${evaluatorPreflight.errors.join("; ")}. Correct the reviewed evaluator, then import, approve, and freeze a new spec. No provider cell was started, and this command did not modify the frozen spec or approval ledger.`,
    );
  }
  const runId = `${mode}-${source.id}-${stableId({ source: source.artifact, sourcePath: source.path, mode, provider: true })}`;
  const runRelativeRoot = path.posix.join("runs", runId);
  const runRoot = path.join(artifactRoot(paths, scope), "runs", runId);
  try {
    const reservedRunRoot = reserveSkillBenchArtifactRoot(
      paths,
      scope,
      runRelativeRoot,
      "run",
      runId,
    );
    if (reservedRunRoot !== runRoot)
      throw new Error("run output reservation resolved to an unexpected path");
  } catch (error) {
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: run output could not be reserved safely before provider spend: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (approveSpend) {
    const recordFailure = recordLiveSpendApproval(source);
    if (recordFailure) return recordFailure;
  }
  const spendApprovalFailure = validateLiveSpendApproval(source);
  if (spendApprovalFailure) return spendApprovalFailure;
  approvals = { ...approvals, liveCellsAllowed: true };
  let sourceApproval: { specContentHash: string; ledgerSha256: string };
  try {
    sourceApproval = persistRunApprovalProof(
      source,
      runRoot,
      scopeBaseFromPaths(paths, scope),
    );
  } catch (error) {
    return fail(
      `Skill-bench ${mode} run disabled for ${source.id}: run approval proof could not be persisted safely before provider spend: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const publicPricing =
    embeddedPublicPricing ?? (await resolveGitHubCopilotPricing());
  const state = {
    spentUsd: 0,
    premiumRequests: 0,
    runtimeMs: 0,
    startedCells: 0,
  };
  const transport = currentSkillBenchProviderTransport();
  const reportCells: SkillBenchReportInput["cells"] = [];
  const runCells: Record<string, unknown>[] = [];
  const evidenceBundles: Array<{ cellId: string; status: string; missingArtifacts: string[] }> = [];
  let actualSpentUsd = 0;
  let actualPremiumRequests = 0;
  let actualCostComplete = true;
  let actualPremiumComplete = true;
  let budgetStop: BudgetStopReason | null = null;
  const workspaceRoot = createProviderWorkspaceRoot(runId);

  try {
  providerBatches: for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const scenarioId = idFromRecordOrString(scenario, "scenario", scenarioIndex);
    const storedFixturePath = stringFromAnyKey(scenario, [
      "fixturePath",
      "visibleFixturePath",
    ]);
    const fixtureSourcePath = storedFixturePath
      ? path.isAbsolute(storedFixturePath)
        ? path.resolve(storedFixturePath)
        : path.resolve(path.dirname(source.path), storedFixturePath)
      : undefined;
    const visibleFixtureFingerprint = fingerprintValue(
      scenario.visibleFixtureFingerprint,
      stableId({ scenario, source: source.id }),
    );
    if (fixtureSourcePath && typeof scenario.visibleFixtureFingerprint !== "string") {
      return fail(
        `Skill-bench ${mode} run disabled for ${source.id}: scenario ${scenarioId} fixture fingerprint required.`,
      );
    }
    for (const modelId of models) {
      const batch = buildMatchedExecutionCells({
        runId,
        scenarioId,
        task: scenarioTask(scenario, scenarioId),
        visibleFixtureFingerprint,
        modelId,
        permissions: [...(executionProfile.allowlistedTools ?? [])],
        timeoutMs: numberFrom(scenario.timeoutMs, 30_000),
        contextFingerprint: fingerprintValue(
          source.artifact.contextFingerprint,
          stableId({ source: source.id, scenarioId }),
        ),
        seed: fingerprintValue(scenario.seed, `${runId}-${scenarioId}-${modelId}`),
        workspaceSource: {
          kind: fixtureSourcePath ? "frozen-fixture" : "empty-provider-cell",
          fingerprint: fixtureSourcePath
            ? visibleFixtureFingerprint
            : fingerprintValue(
                source.artifact.workspaceFingerprint,
                stableId(source.artifact),
              ),
          sourcePath: fixtureSourcePath,
        },
        executionProfile: {
          ...executionProfile,
        },
        selectedSkillId: skillId,
        selectedSkillPath: skillSourcePath,
        selectedSkillFingerprint: frozenSkillFingerprint,
        promptArm: promptArm ?? undefined,
        runRoot,
        workspaceRoot,
      }).filter((cell) => arms.includes(cell.arm));
      const schedule = scheduleCellsWithinCeilings(batch, {
        ...state,
        ceilings,
        estimatedCell: {
          usd: estimatedCellUsd,
          premiumRequests: estimatedCellPremiumRequests,
          runtimeMs: Math.max(0, ...batch.map((cell) => cell.timeoutMs)),
        },
        retryPolicy: { maxAttempts: 1, retryInfrastructure: false },
      });
      if (schedule.stopReason) {
        budgetStop = schedule.stopReason;
        break providerBatches;
      }
      for (const cell of schedule.cellsToStart) {
        try {
          ensureProviderWorkspace(cell);
        } catch (error) {
          return fail(`Skill-bench ${mode} run disabled for ${source.id}: ${error instanceof Error ? error.message : String(error)}.`);
        }
        const request = buildCandidateRequest(cell);
        const startedAt = new Date().toISOString();
        const result = await transport(request);
        const completedAt = new Date().toISOString();
        const elapsedMs = Math.max(
          0,
          Date.parse(completedAt) - Date.parse(startedAt),
        );
        const rawUsage = isRecord(result.usage) ? result.usage : {};
        const directCostUsd = isNonNegativeNumber(rawUsage.costUsd)
          ? rawUsage.costUsd
          : null;
        const publicCost =
          directCostUsd === null && publicPricing
            ? estimatePublicTokenCost({
                modelId: cell.modelId,
                usage: {
                  inputTokens: finiteUsage(rawUsage.inputTokens),
                  outputTokens: finiteUsage(rawUsage.outputTokens),
                  cacheReadTokens: finiteUsage(rawUsage.cacheReadTokens),
                  cacheWriteTokens: finiteUsage(rawUsage.cacheWriteTokens),
                  reasoningTokens: finiteUsage(rawUsage.reasoningTokens),
                },
                snapshot: publicPricing,
              })
            : { value: null, known: false };
        const costUsd = directCostUsd ?? publicCost.value;
        const usage: Record<string, unknown> & {
          costUsd: number | null;
          costProvenance: string;
        } = {
          ...rawUsage,
          costUsd,
          costProvenance:
            directCostUsd !== null
              ? String(rawUsage.provenance ?? "direct-provider-telemetry")
              : publicCost.known
                ? "public-price-snapshot"
                : "unknown",
        };
        const evidencedResult = { ...result, usage };
        const relative = path.posix.join(runRelativeRoot, "cells", cell.id);
        const score = await scoreProviderCell(paths, scope, relative, cell, request, evidencedResult, evaluator);
        const bundle = writeProviderCell(paths, scope, relative, cell, request, evidencedResult, score, { startedAt, completedAt });
        evidenceBundles.push({ cellId: cell.id, ...bundle });
        const premiumRequests =
          isNonNegativeNumber(usage.premiumRequests)
            ? usage.premiumRequests
            : null;
        if (directCostUsd === null) actualCostComplete = false;
        else actualSpentUsd += directCostUsd;
        if (premiumRequests === null) actualPremiumComplete = false;
        else actualPremiumRequests += premiumRequests;
        state.spentUsd += Math.max(estimatedCellUsd, costUsd ?? 0);
        state.premiumRequests += Math.max(
          estimatedCellPremiumRequests,
          premiumRequests ?? 0,
        );
        state.runtimeMs += elapsedMs;
        state.startedCells += 1;
        const status = providerCellStatus(evidencedResult, bundle.status, score);
        const proofMatrix = score.status === "complete" ? score.proofMatrix : emptyProofMatrix(scenario, cell.id);
        const qualityScore = score.status === "complete" ? score.qualityScore : 0;
        const qualityPassed =
          score.status === "complete" &&
          qualityScore >= scenarioQualityPassThreshold(scenario);
        reportCells.push({
          id: cell.id,
          taskId: cell.scenarioId,
          arm: cell.arm,
          modelId: cell.modelId,
          status,
          hardGatesPassed: status === "complete",
          qualityPassed,
          qualityScore,
          costUsd,
          latencyMs:
            typeof usage.durationMs === "number" ? usage.durationMs : elapsedMs,
          samples: status === "complete" ? 1 : 0,
          scenariosCovered: 1,
          scenariosRequired: 1,
          proofMatrix,
          evidencePaths: REQUIRED_EVIDENCE_ARTIFACTS.map((artifact) => `${relative}/${artifact}`),
          tokens: {
            input: usage.inputTokens ?? null,
            output: usage.outputTokens ?? null,
            cacheRead: usage.cacheReadTokens ?? null,
            cacheWrite: usage.cacheWriteTokens ?? null,
            reasoning: usage.reasoningTokens ?? null,
            total: usage.totalTokens ?? null,
            totalProvenance: usage.totalProvenance ?? null,
            premiumRequests,
            costUsd,
            costProvenance: usage.costProvenance,
            completeness: String(usage.completeness ?? "unknown"),
            provenance: String(usage.provenance ?? "provider-transport"),
          },
        });
        runCells.push({ id: cell.id, status, qualityPassed, scenarioId: cell.scenarioId, modelId: cell.modelId, arm: cell.arm });
      }
    }
  }

  const skillFp = frozenSkillFingerprint;
  const modelFp = stableId({ models });
  const specFp = specContentHash(source.artifact);
  const evalFp = evaluator.evaluator.sha256.toLowerCase();
  const providerFp = PROVIDER_TRANSPORT_FINGERPRINT;
  const budgetStopMessage = budgetStop
    ? `budget stopped before next matched batch: ${budgetStop.detail}`
    : null;
  const reportInput: SkillBenchReportInput = {
    schemaVersion: 1,
    runId,
    mode,
    status: "completed",
    spec: {
      id: source.id,
      fingerprint: specFp,
      evaluationFingerprint: evalFp,
      seed: stableId({ source: source.id, mode }),
      rerunCommand: `omp skill-bench rerun ${runId}`,
    },
    skill: { id: skillId, fingerprint: skillFp },
    model: {
      id: models.length === 1 ? models[0] : "multiple-approved-models",
      fingerprint: modelFp,
    },
    environment: { provider: "copilot", fingerprint: providerFp },
    pricing: providerPricing(
      source.artifact,
      actualCostComplete,
      publicPricing,
    ),
    budget: {
      maxUsd: ceilings.maxUsd,
      maxCells: ceilings.maxCells,
      maxRuntimeMs: ceilings.maxRuntimeMs,
      maxPremiumRequests: ceilings.maxPremiumRequests,
      spentUsd: actualCostComplete ? actualSpentUsd : null,
      premiumRequests: actualPremiumComplete ? actualPremiumRequests : null,
      cells: state.startedCells,
      estimatedSpentUsd: state.spentUsd,
      estimatedPremiumRequests: state.premiumRequests,
      actualTelemetryCompleteness:
        actualCostComplete && actualPremiumComplete ? "known" : "unknown",
      estimateProvenance: "approved-conservative-per-cell",
    },
    warnings: [
      ...(mode === "pilot" ? ["pilot mode does not emit a validated winner"] : []),
      ...(budgetStopMessage ? [budgetStopMessage] : []),
      ...(!actualCostComplete || !actualPremiumComplete
        ? ["actual provider cost/premium telemetry is incomplete; approved conservative estimates enforced the budget"]
        : []),
    ],
    confidence: buildRunConfidence(
      mode,
      runId,
      reportCells.map((cell) => ({
        scenarioId: cell.taskId,
        modelId: cell.modelId,
        arm: cell.arm,
        qualityScore: cell.qualityScore,
        status: cell.status,
        hardGatesPassed: cell.hardGatesPassed,
      })),
      {
        specHash: specContentHash(source.artifact),
        armIds: arms,
        scenarios,
        approvedMaximumMatchedUnits: Math.floor(ceilings.maxCells / arms.length),
      },
    ),
    cells: reportCells,
  };
  const reportView = normalizeSkillBenchReport(reportInput);
  if (budgetStop) applyBudgetStopDecision(reportView, budgetStop);
  const recommendationTarget =
    mode === "validated" && reportView.decision.validated
      ? selectRecommendationTarget(reportView, source.artifact)
      : null;
  reportView.decision.recommendedRoute = recommendationTarget
    ? {
        skillId,
        modelId: recommendationTarget.modelId,
        objective: recommendationTarget.objective,
      }
    : null;
  const recommendation =
    mode === "validated" && reportView.decision.validated && recommendationTarget
      ? ({
          schemaVersion: 1,
          id: `rec-${runId}`,
          runId,
          action: "advisory",
          status: "ready",
          validated: true,
          humanApprovedPolicy: null,
          scope,
          taskMatcher: fingerprintValue(source.artifact.taskMatcher, source.id),
          objective: recommendationTarget.objective,
          selectedSkill: { id: skillId, fingerprint: skillFp },
          selectedModel: { id: recommendationTarget.modelId, fingerprint: modelFp },
          fingerprints: { spec: specFp, evaluation: evalFp, provider: providerFp },
          confidence: {
            verdict: reportView.decision.confidence.verdict,
            samples: reportView.decision.confidence.sampleCount,
            scenarioCoverage: reportView.decision.coverage.scenarioCoverage,
          },
          evidencePath: `${runRelativeRoot}/summary.json`,
        } satisfies RoutingRecommendationV1 & { action: string; status: string })
      : null;
  const summary = {
    schemaVersion: 1,
    id: `summary-${runId}`,
    runId,
    mode,
    status: reportView.decision.validated ? "winner" : "inconclusive",
    synthetic: false,
    cells: reportCells.length,
  };
  const pricingRelativePath = publicPricing
    ? path.posix.join(runRelativeRoot, "pricing.json")
    : null;
  const runArtifact = {
    schemaVersion: 1,
    id: runId,
    specId: source.id,
    sourceId: source.id,
    sourceKind: source.kind,
    sourcePath: safeSourceReference(paths, scope, source),
    sourceFingerprint: stableId(source.artifact),
    sourceApproval,
    mode,
    status: "complete",
    synthetic: false,
    provider: { kind: "copilot", transport: PROVIDER_TRANSPORT_FINGERPRINT },
    approvals,
    fingerprint: { status: "current" },
    currentFingerprints: { skill: skillFp, model: modelFp, spec: specFp, evaluation: evalFp, provider: providerFp },
    conflicts: { status: "clear" },
    budgetStop: budgetStop ?? undefined,
    evidence: evidenceBundles.length > 0 &&
      evidenceBundles.every((bundle) => bundle.status === "complete")
      ? { status: "verified" }
      : {
          status: "incomplete-evidence",
          ...(evidenceBundles.length === 0 ? { reason: "no-completed-cells" } : {}),
          missingBundles: evidenceBundles.filter((bundle) => bundle.status !== "complete"),
        },
    recommendation: recommendation ?? undefined,
    routingCapabilities: copilotAdvisoryCapabilities(recommendation),
    cells: runCells,
    reportPath: `${runRelativeRoot}/sweep_report.html`,
    reportInput,
    reportView,
    summary,
    summaryPath: `${runRelativeRoot}/summary.json`,
    exportManifest: {
      files: [
        `${runRelativeRoot}/run.json`,
        `${runRelativeRoot}/approvals.jsonl`,
        `${runRelativeRoot}/summary.json`,
        ...(pricingRelativePath ? [pricingRelativePath] : []),
        ...(recommendation
          ? [`${runRelativeRoot}/recommendation.json`]
          : []),
        `${runRelativeRoot}/sweep_report.html`,
        ...reportInput.cells.flatMap((cell) => [
          ...cell.evidencePaths,
          `${path.posix.dirname(cell.evidencePaths[0] ?? `${runRelativeRoot}/cells/${cell.id}/request.json`)}/COMPLETE`,
        ]),
      ],
    },
  };
  if (pricingRelativePath && publicPricing)
    writeSkillBenchJsonAtomic(
      paths,
      scope,
      pricingRelativePath,
      publicPricing,
    );
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(runRelativeRoot, "summary.json"), summary);
  if (recommendation) writeSkillBenchJsonAtomic(paths, scope, path.posix.join(runRelativeRoot, "recommendation.json"), recommendation);
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(runRelativeRoot, "run.json"), runArtifact);
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(runRelativeRoot, "sweep_report.html"),
    renderSkillBenchReportHtml(reportView),
  );
  const output = {
    schemaVersion: 1,
    phase: "run",
    id: runId,
    sourceId: source.id,
    mode,
    status: "complete",
    synthetic: false,
    cells: reportCells.length,
    budgetStopReason: budgetStop?.detail ?? null,
    runPath: displayPath(cwd, path.join(runRoot, "run.json")),
    reportPath: displayPath(cwd, path.join(runRoot, "sweep_report.html")),
  };
  return {
    ok: true,
    output,
    message: `${mode} provider run completed for ${source.id}${budgetStop ? ` with ${budgetStop.detail} before the next matched batch` : ""}\nrun-id=${runId}\ncells=${reportCells.length}\nrun: ${output.runPath}\nreport: ${output.reportPath}`,
  };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function runtimeCeilingMs(budgets: Record<string, unknown>): number {
  if (budgets.maxRuntimeMs !== undefined)
    return numberFrom(budgets.maxRuntimeMs, 120_000);
  const minutes = numberFrom(budgets.maxRuntimeMinutes, 2);
  return minutes * 60_000;
}

function scenarioTask(scenario: Record<string, unknown>, fallback: string): string {
  return String(scenario.task ?? scenario.title ?? scenario.name ?? fallback);
}

function scenarioQualityPassThreshold(scenario: Record<string, unknown>): number {
  return numberFrom(nestedRecord(scenario, "threshold").pass, 0);
}

function executionProfileKind(value: unknown): "restricted" | "normal-project" | "custom" {
  return value === "normal-project" || value === "custom" ? value : "restricted";
}

function providerExecutionProfile(
  artifact: Record<string, unknown>,
): ExecutionProfileConfig | CliResult {
  const kind = executionProfileKind(artifact.executionProfile);
  const execution = nestedRecord(artifact, "execution");
  const allowlistedTools = [
    ...new Set(
      stringArray(
        execution.allowlistedTools ??
          artifact.allowlistedTools ??
          artifact.permissions,
      ),
    ),
  ];
  if (allowlistedTools.length === 0) {
    return fail(
      `Skill-bench provider run disabled: ${kind} execution profile requires an explicit non-empty allowlistedTools list.`,
    );
  }
  const customInstructions =
    stringFromAnyKey(execution, ["customInstructions"]) ??
    stringFromAnyKey(artifact, ["customInstructions"]);
  if (kind === "custom" && !customInstructions) {
    return fail(
      "Skill-bench provider run disabled: custom execution profile requires frozen customInstructions.",
    );
  }
  if (kind === "restricted" && customInstructions) {
    return fail(
      "Skill-bench provider run disabled: restricted execution profile cannot include customInstructions.",
    );
  }
  return {
    kind,
    allowlistedTools,
    customInstructions: kind === "restricted" ? null : (customInstructions ?? null),
  };
}

function providerPricing(
  artifact: Record<string, unknown>,
  directCostComplete: boolean,
  publicPricing: PublicPricingSnapshot | null,
): SkillBenchReportInput["pricing"] {
  if (directCostComplete) {
    return {
      source: "direct-copilot-cell-telemetry",
      currency: "USD",
      completeness: "complete",
    };
  }
  if (publicPricing) {
    return {
      source:
        publicPricing.source ??
        stringFromAnyKey(nestedRecord(artifact, "pricing"), ["source"]) ??
        "public-price-snapshot",
      url: publicPricing.url,
      retrievedAt: publicPricing.retrievedAt,
      currency: publicPricing.currency,
      completeness:
        publicPricing.completeness ?? "unambiguous-model-rates",
    };
  }
  const pricing = nestedRecord(artifact, "pricing");
  const source = stringFromAnyKey(pricing, ["source"]);
  return {
    source: source ?? "unknown",
    url: stringFromAnyKey(pricing, ["url"]),
    retrievedAt: stringFromAnyKey(pricing, ["retrievedAt", "fetchedAt"]),
    currency: stringFromAnyKey(pricing, ["currency"]),
    completeness:
      stringFromAnyKey(pricing, ["completeness"]) ??
      (source ? "public-snapshot" : "unknown"),
  };
}

function readBudgetStop(value: unknown): BudgetStopReason | null {
  if (!isRecord(value) || value.family !== "budget") return null;
  switch (value.detail) {
    case "usd-ceiling":
    case "premium-ceiling":
    case "runtime-ceiling":
    case "cell-ceiling":
      return { family: "budget", detail: value.detail };
    default:
      return null;
  }
}

function applyBudgetStopDecision(
  view: SkillBenchReportView,
  stop: BudgetStopReason,
): void {
  const reason = `budget stopped before next matched batch: ${stop.detail}`;
  view.decision.state = "inconclusive";
  view.decision.validated = false;
  view.decision.noWinnerReason = reason;
  view.decision.recommendedRoute = null;
  view.decision.confidence = {
    ...view.decision.confidence,
    verdict: "inconclusive",
    noWinnerReason: reason,
  };
  view.recommendation = null;
  view.actions.canApply = false;
}

function approvedPublicPricing(
  artifact: Record<string, unknown>,
): PublicPricingSnapshot | null | CliResult {
  const pricing = nestedRecord(artifact, "pricing");
  if (pricing.models === undefined) return null;
  const url = stringFromAnyKey(pricing, ["url"]);
  const retrievedAt = stringFromAnyKey(pricing, ["retrievedAt", "fetchedAt"]);
  if (!url || !retrievedAt || pricing.currency !== "USD" || !isRecord(pricing.models)) {
    return fail(
      "Skill-bench provider run disabled: public pricing models require URL, retrieval time, USD currency, and model rates.",
    );
  }
  const models: Record<string, PublicModelTokenRates> = {};
  for (const [modelId, rawRates] of Object.entries(pricing.models)) {
    if (!SAFE_MODEL_ID.test(modelId) || !isRecord(rawRates)) {
      return fail(
        `Skill-bench provider run disabled: invalid public pricing model ${modelId}.`,
      );
    }
    const required = [rawRates.inputUsdPerMillion, rawRates.outputUsdPerMillion];
    const optional = [
      rawRates.cacheReadUsdPerMillion,
      rawRates.cacheWriteUsdPerMillion,
      rawRates.reasoningUsdPerMillion,
    ];
    if (
      required.some((value) => !isNonNegativeNumber(value)) ||
      optional.some(
        (value) => value !== undefined && !isNonNegativeNumber(value),
      )
    ) {
      return fail(
        `Skill-bench provider run disabled: invalid public pricing rates for ${modelId}.`,
      );
    }
    models[modelId] = rawRates as unknown as PublicModelTokenRates;
  }
  if (Object.keys(models).length === 0) {
    return fail(
      "Skill-bench provider run disabled: public pricing model rates are empty.",
    );
  }
  return {
    source:
      stringFromAnyKey(pricing, ["source"]) ?? "public-price-snapshot",
    apiUrl: stringFromAnyKey(pricing, ["apiUrl"]),
    url,
    retrievedAt,
    currency: "USD",
    completeness:
      stringFromAnyKey(pricing, ["completeness"]) ??
      "reviewed-model-rates",
    models,
  };
}

type ReportPricingRefreshStatus =
  | "not-needed"
  | "refreshed"
  | "unavailable"
  | "unresolved";

async function refreshUnknownRunPricing(
  run: LoadedArtifact,
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
): Promise<{ run: LoadedArtifact; status: ReportPricingRefreshStatus }> {
  if (!isRecord(run.artifact.reportInput))
    return { run, status: "not-needed" };
  const reportInput = run.artifact
    .reportInput as unknown as SkillBenchReportInput;
  if (!reportInput.cells.some((cell) => !isNonNegativeNumber(cell.costUsd)))
    return { run, status: "not-needed" };

  const runRoot = path.dirname(run.path);
  const storedPricingPath = path.join(runRoot, "pricing.json");
  let publicPricing: PublicPricingSnapshot | null = null;
  if (existsSync(storedPricingPath)) {
    const stored = loadJsonFile(storedPricingPath, run.trustedRoot);
    if (isRecord(stored)) {
      const approved = approvedPublicPricing({ pricing: stored });
      if (approved && !isCliFailure(approved)) publicPricing = approved;
    }
  }
  publicPricing ??= await resolveGitHubCopilotPricing();
  if (!publicPricing) return { run, status: "unavailable" };

  let changed = false;
  const cells = reportInput.cells.map((cell) => {
    if (isNonNegativeNumber(cell.costUsd)) return cell;
    const tokens = cell.tokens;
    const estimated = estimatePublicTokenCost({
      modelId: cell.modelId,
      usage: {
        inputTokens: usageNumber(tokens, ["input", "inputTokens"]),
        outputTokens: usageNumber(tokens, ["output", "outputTokens"]),
        cacheReadTokens: usageNumber(tokens, [
          "cacheRead",
          "cacheReadTokens",
          "cachedInputTokens",
        ]),
        cacheWriteTokens: usageNumber(tokens, [
          "cacheWrite",
          "cacheWriteTokens",
        ]),
        reasoningTokens: usageNumber(tokens, [
          "reasoning",
          "reasoningTokens",
        ]),
      },
      snapshot: publicPricing,
    });
    if (!estimated.known || estimated.value === null) return cell;
    changed = true;
    return {
      ...cell,
      costUsd: estimated.value,
      tokens: {
        ...cell.tokens,
        costUsd: estimated.value,
        costProvenance: "public-price-snapshot",
      },
    };
  });
  if (!changed) return { run, status: "unresolved" };

  const refreshedInput: SkillBenchReportInput = {
    ...reportInput,
    pricing: providerPricing({}, false, publicPricing),
    warnings: [
      ...new Set([
        ...reportInput.warnings,
        "USD cost estimated from the saved GitHub Copilot public pricing snapshot; not a GitHub Copilot invoice",
      ]),
    ],
    cells,
  };
  const refreshedView = normalizeSkillBenchReport(refreshedInput);
  const budgetStop = readBudgetStop(run.artifact.budgetStop);
  if (budgetStop) applyBudgetStopDecision(refreshedView, budgetStop);
  const previousView = isRecord(run.artifact.reportView)
    ? (run.artifact.reportView as unknown as SkillBenchReportView)
    : null;
  if (!budgetStop && previousView?.decision.recommendedRoute)
    refreshedView.decision.recommendedRoute = {
      ...previousView.decision.recommendedRoute,
    };

  const runRelativeRoot = path.posix.dirname(
    artifactRelativePath(paths, scope, run.path),
  );
  const pricingRelativePath = path.posix.join(
    runRelativeRoot,
    "pricing.json",
  );
  const exportManifest = nestedRecord(run.artifact, "exportManifest");
  const exportFiles = [
    ...new Set([...stringArray(exportManifest.files), pricingRelativePath]),
  ];
  const refreshedArtifact = {
    ...run.artifact,
    reportInput: refreshedInput,
    reportView: refreshedView,
    exportManifest: { ...exportManifest, files: exportFiles },
  };
  const validation = validateRunV1(
    normalizeRunForV1Validation(refreshedArtifact),
  );
  if (!validation.ok) return { run, status: "unresolved" };

  writeSkillBenchJsonAtomic(
    paths,
    scope,
    pricingRelativePath,
    publicPricing,
  );
  writeSkillBenchJsonAtomic(
    paths,
    scope,
    artifactRelativePath(paths, scope, run.path),
    refreshedArtifact,
  );
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(runRelativeRoot, "sweep_report.html"),
    renderSkillBenchReportHtml(refreshedView),
  );
  return {
    run: { ...run, artifact: refreshedArtifact },
    status: "refreshed",
  };
}

function usageNumber(
  tokens: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = tokens[key];
    if (isNonNegativeNumber(value)) return value;
  }
  return undefined;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteUsage(value: unknown): number | undefined {
  return isNonNegativeNumber(value) ? value : undefined;
}

function skillIdFromArms(artifact: Record<string, unknown>): string | null {
  const arms = recordsFrom(artifact.arms);
  const skillArm = arms.find((arm) => arm.kind === "skill");
  return typeof skillArm?.skillId === "string" ? skillArm.skillId : null;
}

type ProviderCellScore =
  | { status: "complete"; qualityScore: number; proofMatrix: { expected: string[]; found: string[]; done: string[]; missed: string[]; falsePositive: string[]; incorrect: string[]; proof: string[] }; scorer: unknown }
  | { status: "scorer-failure"; errors: string[]; scorer: unknown };

async function preflightProviderEvaluator(
  evaluator: { argv: string[]; evaluator: FrozenEvaluatorDescriptorV1 },
  sourceId: string,
): Promise<{ status: "ok" } | { status: "scorer-failure"; errors: string[] }> {
  const workspaceRoot = createProviderWorkspaceRoot(
    `evaluator-preflight-${sourceId}`,
  );
  try {
    const preflightRoot = path.join(
      workspaceRoot,
      "evaluator-contract-preflight",
    );
    mkdirSync(preflightRoot, { recursive: true });
    const responsePath = path.join(preflightRoot, "response.json");
    writeFileSync(
      responsePath,
      `${canonicalJson({
        schemaVersion: 1,
        status: "complete",
        stdout: "",
        stderr: "",
        exitCode: 0,
      })}\n`,
    );
    const evaluated = await runEvaluatorV1({
      command: { argv: evaluator.argv, evaluator: evaluator.evaluator },
      request: {
        schemaVersion: 1,
        cellId: "evaluator-contract-preflight",
        evaluator: evaluator.evaluator,
        declaredEvidence: [
          { path: responsePath, sha256: hashFile(responsePath) },
        ],
      },
      evidenceRoot: preflightRoot,
      timeoutMs: 30_000,
      maxStdoutBytes: 128_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });
    return evaluated.status === "ok"
      ? { status: "ok" }
      : { status: "scorer-failure", errors: evaluated.errors };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function scoreProviderCell(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cellRelative: string,
  cell: ExecutionCell,
  request: unknown,
  result: {
    status: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  },
  evaluator: { argv: string[]; evaluator: FrozenEvaluatorDescriptorV1 },
): Promise<ProviderCellScore> {
  const cellRoot = path.join(artifactRoot(paths, scope), ...cellRelative.split("/"));
  mkdirSync(cellRoot, { recursive: true });
  const response = {
    schemaVersion: 1,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "response.json"), response);
  const responsePath = path.join(cellRoot, "response.json");
  const evaluated = await runEvaluatorV1({
    command: { argv: evaluator.argv, evaluator: evaluator.evaluator },
    request: {
      schemaVersion: 1,
      cellId: cell.id,
      evaluator: evaluator.evaluator,
      declaredEvidence: [{ path: responsePath, sha256: hashFile(responsePath) }],
    },
    evidenceRoot: cellRoot,
    timeoutMs: cell.timeoutMs,
    maxStdoutBytes: 128_000,
    envAllowlist: { PATH: process.env.PATH ?? "" },
  });
  if (evaluated.status !== "ok")
    return {
      status: "scorer-failure",
      errors: evaluated.errors,
      scorer: { schemaVersion: 1, status: "scorer-failure", errors: evaluated.errors, spawn: evaluated.spawn },
    };
  const proofMatrix = {
    ...evaluated.result.proofMatrix,
    proof: evaluated.result.proofMatrix.proof.map((entry) =>
      reportProofEntry(entry, cellRoot),
    ),
  };
  return {
    status: "complete",
    qualityScore: evaluated.result.score,
    proofMatrix,
    scorer: { schemaVersion: 1, status: "complete", result: evaluated.result, spawn: evaluated.spawn },
  };
}

function reportProofEntry(entry: string, cellRoot: string): string {
  if (!path.isAbsolute(entry)) return entry;
  const relative = path.relative(cellRoot, entry);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "[absolute proof path redacted]";
  }
  return relative.split(path.sep).join("/");
}

function providerCellStatus(
  result: { status: string; exitCode: number | null },
  evidenceStatus: string,
  score: ProviderCellScore,
): SkillBenchReportInput["cells"][number]["status"] {
  if (evidenceStatus !== "complete") return "incomplete";
  if (result.status === "unavailable") return "availability-failure";
  if (result.status === "quota") return "quota-failure";
  if (result.status === "timeout" || result.status === "error" || (result.exitCode !== null && result.exitCode !== 0)) return "infrastructure-failure";
  if (score.status !== "complete") return "scorer-failure";
  return "complete";
}

function emptyProofMatrix(scenario: Record<string, unknown>, cellId: string) {
  const expected = stringArray(scenario.expected);
  return {
    expected: expected.length > 0 ? expected : [scenarioTask(scenario, cellId)],
    found: [],
    done: [],
    missed: [],
    falsePositive: [],
    incorrect: [],
    proof: [],
  };
}

function writeProviderCell(
  paths: SkillBenchPaths,
  scope: SkillBenchScope,
  cellRelative: string,
  cell: ExecutionCell,
  request: unknown,
  result: {
    status: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    usage?: Record<string, unknown>;
    sessionTelemetry?: {
      schemaVersion: 1;
      source: "copilot-session-events";
      eventType: "session.shutdown";
      sourceSha256: string;
      usage: Record<string, unknown>;
    };
  },
  score: ProviderCellScore,
  timestamps: { startedAt: string; completedAt: string },
): { status: "complete" | "incomplete-evidence"; missingArtifacts: string[] } {
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "request.json"), request);
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "response.json"), {
    schemaVersion: 1,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "result.json"), {
    schemaVersion: 1,
    status: result.status,
    qualityScore: score.status === "complete" ? score.qualityScore : null,
    scorerStatus: score.status,
  });
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "scorer.json"), score.scorer);
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "usage.json"), {
    schemaVersion: 1,
    ...(result.usage ?? {}),
    costUsd: typeof result.usage?.costUsd === "number" ? result.usage.costUsd : null,
    premiumRequests: typeof result.usage?.premiumRequests === "number" ? result.usage.premiumRequests : null,
    completeness: String(result.usage?.completeness ?? "unknown"),
    provenance: String(result.usage?.provenance ?? "provider-transport"),
    sessionTelemetry: result.sessionTelemetry
      ? {
          schemaVersion: result.sessionTelemetry.schemaVersion,
          source: result.sessionTelemetry.source,
          eventType: result.sessionTelemetry.eventType,
          sourceSha256: result.sessionTelemetry.sourceSha256,
        }
      : undefined,
  });
  writeSkillBenchJsonAtomic(paths, scope, path.posix.join(cellRelative, "timestamps.json"), {
    schemaVersion: 1,
    ...timestamps,
  });
  const cellRoot = path.join(artifactRoot(paths, scope), ...cellRelative.split("/"));
  writeSkillBenchFileAtomic(paths, scope, path.posix.join(cellRelative, "diff.patch"), "");
  writeSkillBenchFileAtomic(paths, scope, path.posix.join(cellRelative, "tests.txt"), "");
  writeSkillBenchFileAtomic(
    paths,
    scope,
    path.posix.join(cellRelative, "transcript.txt"),
    `${canonicalJson({ cellId: cell.id, status: result.status })}\n`,
  );
  return finalizeEvidenceBundle(cellRoot, scopeBaseFromPaths(paths, scope));
}

async function runSubcommand(
  args: string[],
  context: { cwd: string; json: boolean },
): Promise<CliResult> {
  const sub = args[0];
  if (sub === "resume") {
    const explicitId =
      args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const id = explicitId ?? latestDraftId(context.cwd);
    if (typeof id !== "string") return id;
    const start = explicitId ? 2 : 1;
    const importIndex = args.indexOf("--import");
    const approveIndex = args.indexOf("--approve");
    const freeze = args.includes("--freeze");
    const allowed = new Set(["--import", "--approve", "--freeze"]);
    const stray = rejectResumeStray(args, allowed, start);
    if (stray) return stray;
    const loaded = loadPersistedDraft(id, context.cwd);
    if (isCliFailure(loaded)) return loaded;
    if (importIndex >= 0) {
      const importPath = args[importIndex + 1];
      if (!importPath || importPath.startsWith("--")) return fail("--import requires a manifest path.");
      return importReviewedManifest(id, loaded, importPath, context.cwd);
    }
    if (approveIndex >= 0) {
      const gate = args[approveIndex + 1];
      if (!gate || gate.startsWith("--")) return fail("--approve requires a gate id.");
      return approveDraftGate(id, loaded, gate);
    }
    if (freeze) return freezeDraftSpec(id, loaded, context.cwd);
    const output = {
      schemaVersion: 1,
      phase: "design",
      status: "resumed",
      id,
      draftPath: loaded.path,
      approvals: nestedRecord(loaded.artifact, "approvals"),
      next: { action: "continue design, then freeze/export an approved spec before running" },
    };
    return context.json
      ? { ok: true, output }
      : {
          ok: true,
          message: `Resumed skill-bench draft ${id}\ndraft-path=${path.relative(context.cwd, loaded.path) || loaded.path}\napprovals: freeze=false live-cells=blocked
next: continue design, then freeze/export an approved spec before running`,
        };
  }
  if (sub === "run") {
    const id = requireId(
      args,
      "omp skill-bench run <spec-id-or-path> --pilot|--validated [--approve-spend]",
    );
    if (typeof id !== "string") return id;
    const pilot = args.includes("--pilot");
    const validated = args.includes("--validated");
    if (pilot === validated)
      return fail("Choose exactly one run mode: --pilot or --validated.");
    const approveSpend = args.includes("--approve-spend");
    const stray = rejectStray(args, new Set(["--pilot", "--validated", "--approve-spend"]), 2);
    if (stray) return stray;
    const source = loadApprovedSpecTarget(id, context.cwd);
    if (isCliFailure(source)) return source;
    const paths = resolveSkillBenchPaths({ cwd: context.cwd });
    const scope = sourceScope(paths, source.path);
    const mode = pilot ? "pilot" : "validated";
    const result = source.artifact.synthetic === true
      ? buildSyntheticRun(source, mode, paths, scope, context.cwd)
      : await buildProviderRun(
          source,
          mode,
          paths,
          scope,
          context.cwd,
          approveSpend,
        );
    return context.json && result.ok
      ? { ok: true, output: result.output }
      : result;
  }
  if (sub === "report") {
    const id = requireId(
      args,
      "omp skill-bench report <run-id> [--open|--no-open]",
    );
    if (typeof id !== "string") return id;
    if (args.includes("--open") && args.includes("--no-open"))
      return fail("Choose at most one report open mode: --open or --no-open.");
    const stray = rejectStray(args, new Set(["--open", "--no-open"]), 2);
    if (stray) return stray;
    let run = loadCompletedRun(id, context.cwd);
    if (isCliFailure(run)) return run;
    const open = args.includes("--open") && !context.json;
    const paths = resolveSkillBenchPaths({ cwd: context.cwd });
    const scope = artifactScope(paths, run.path);
    const pricingRefresh = await refreshUnknownRunPricing(run, paths, scope);
    run = pricingRefresh.run;
    const expectedReportPath = reportPathForRun(paths, scope, id);
    let effectiveReportPath = expectedReportPath;
    const reportView = isRecord(run.artifact.reportView)
      ? (run.artifact.reportView as unknown as SkillBenchReportView)
      : null;
    const reportInput = isRecord(run.artifact.reportInput)
      ? (run.artifact.reportInput as unknown as SkillBenchReportInput)
      : null;
    if (reportView || reportInput) {
      effectiveReportPath = expectedReportPath;
      mkdirSync(path.dirname(effectiveReportPath), { recursive: true });
      createTextFileIfMissing(effectiveReportPath, () => {
        const view =
          reportView ??
          normalizeSkillBenchReport(reportInput as SkillBenchReportInput);
        return renderSkillBenchReportHtml(view);
      }, run.trustedRoot);
    }
    if (!existsSync(effectiveReportPath)) {
      return fail(
        `No report artifact exists for skill-bench run ${id}; expected ${displayPath(context.cwd, effectiveReportPath)}.`,
      );
    }
    const output = {
      schemaVersion: 1,
      phase: "report",
      id,
      reportPath: displayPath(context.cwd, effectiveReportPath),
      opened: open,
      pricingRefresh: pricingRefresh.status,
      verdict: "artifact-present",
    };
    return context.json
      ? { ok: true, output }
      : {
          ok: true,
          message: `report ready: ${output.reportPath}\nopened=${open}\npricing-refresh=${pricingRefresh.status}`,
        };
  }
  if (sub === "rerun") {
    const id = requireId(args, "omp skill-bench rerun <run-id>");
    if (typeof id !== "string") return id;
    const stray = rejectStray(args, new Set(), 2);
    if (stray) return stray;
    const run = loadCompletedRun(id, context.cwd);
    if (isCliFailure(run)) return run;
    const paths = resolveSkillBenchPaths({ cwd: context.cwd });
    const scope = artifactScope(paths, run.path);
    const liveArtifact = withLiveRerunFingerprints(run.artifact, paths, scope);
    const gate = evaluateRerunFingerprintGate(liveArtifact);
    const rerunId = `rerun-${id}-${stableId({ run: run.artifact, sourcePath: run.path, gate })}`;
    const executableCommand = `omp skill-bench run ${stringField(run.artifact, "sourceId") ?? id} --${stringField(run.artifact, "mode") === "validated" ? "validated" : "pilot"}`;
    const output = {
      schemaVersion: 1,
      phase: "rerun",
      id: rerunId,
      sourceRunId: id,
      sourcePath: artifactRelativePath(paths, scope, run.path),
      status: gate.status,
      mode: stringField(run.artifact, "mode") ?? "unknown",
      sourceId: stringField(run.artifact, "sourceId") ?? null,
      fingerprintCheck: gate.status,
      fingerprintGate: gate,
      frozenInputs: {
        sourceFingerprint:
          stringField(run.artifact, "sourceFingerprint") ?? null,
        fingerprint: nestedRecord(run.artifact, "fingerprint"),
        frozenFingerprints: frozenRerunFingerprints(run.artifact),
        currentFingerprints: currentRerunFingerprints(liveArtifact),
      },
      next:
        gate.status === "ready"
          ? { command: executableCommand }
          : { blockedReason: rerunBlockedReason(gate) },
    };
    const relative = path.posix.join(
      "runs",
      id,
      "reruns",
      rerunId,
      "plan.json",
    );
    const persistedPath = writeSkillBenchJsonAtomic(
      paths,
      scope,
      relative,
      output,
    );
    const persistedOutput = {
      ...output,
      planPath: displayPath(context.cwd, persistedPath),
    };
    if (gate.status === "blocked") {
      const message = `rerun blocked for ${id}\nplan: ${persistedOutput.planPath}\nreason: ${rerunBlockedReason(gate)}\nno executable rerun was prepared`;
      return context.json
        ? { ok: false, exitCode: 1, message, output: persistedOutput }
        : fail(message);
    }
    return context.json
      ? { ok: true, output: persistedOutput }
      : {
          ok: true,
          message: `rerun prepared for ${id}\nplan: ${persistedOutput.planPath}\nfingerprint check ready`,
        };
  }
  if (sub === "apply") {
    const id = requireId(args, "omp skill-bench apply <run-id> [--dry-run]");
    if (typeof id !== "string") return id;
    let requestedScope: RoutingScope | undefined;
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] !== "--scope") continue;
      const value = readValue(args, i, "--scope");
      if (value !== "project" && value !== "global" && value !== "user")
        return fail("--scope accepts: project, user.");
      requestedScope = value === "user" ? "global" : value;
      i += 1;
    }
    const scopeValue = args.includes("--scope")
      ? args[args.indexOf("--scope") + 1]
      : undefined;
    const stray = rejectStray(
      args,
      new Set(["--dry-run", "--scope", ...(scopeValue ? [scopeValue] : [])]),
      2,
    );
    if (stray) return stray;
    const dryRun = args.includes("--dry-run");
    const run = loadApplicableRun(id, context.cwd);
    if (isCliFailure(run)) return run;
    const recommendation = runRecommendation(run.artifact);
    if (!recommendation)
      return fail(
        `Skill-bench apply disabled for ${id}: missing routing recommendation.`,
      );
    const paths = resolveSkillBenchPaths({ cwd: context.cwd });
    const runScope = artifactScope(paths, run.path);
    const effectiveScope = requestedScope ?? recommendation.scope;
    let plan;
    try {
      plan = planSkillBenchRouteApply({
        recommendation,
        dryRun,
        currentFingerprints: (() => {
          const liveArtifact = stringField(run.artifact, "sourcePath")
            ? withLiveRerunFingerprints(run.artifact, paths, runScope)
            : run.artifact;
          const current = currentFingerprints(liveArtifact);
          if (!current)
            throw new Error(
              "missing current fingerprints; routing is stale/unverified",
            );
          return current;
        })(),
        existingRules: currentRouteRules({
          cwd: context.cwd,
          paths,
          scope: effectiveScope,
          artifactRules: routeRules(run.artifact.existingRules),
        }),
        routingCapabilities: verifiedRoutingCapabilities(
          run,
          paths,
          runScope,
          recommendation,
        ),
        requestedScope: effectiveScope,
        explicitBypass: run.artifact.explicitBypass === true,
      });
    } catch (error) {
      return fail(
        `Skill-bench apply disabled for ${id}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    const output = {
      schemaVersion: 1,
      phase: "apply",
      id,
      ...plan,
      capability: plan.enforced
        ? "enforced"
        : plan.disabledReason
          ? "unsupported"
          : "advisory",
    };
    const conflictDetails = formatRouteConflicts(plan.conflicts);
    if (!dryRun && plan.disabledReason)
      return fail(
        `Skill-bench apply disabled for ${id}: ${plan.disabledReason}.${conflictDetails ? ` ${conflictDetails}.` : ""}`,
      );
    let instructionPath: string | null = null;
    let routeStatePath: string | null = null;
    if (!dryRun && !plan.enforced && plan.mutations.length > 0) {
      try {
        instructionPath = writeAdvisoryRouteInstructions({
          cwd: context.cwd,
          scope: effectiveScope,
          recommendation,
        });
      } catch (error) {
        return fail(
          `Skill-bench apply disabled for ${id}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
    if (!dryRun && !plan.disabledReason) {
      try {
        routeStatePath = persistManagedRoute({
          cwd: context.cwd,
          paths,
          scope: effectiveScope,
          recommendation,
          capability: plan.enforced ? "enforced" : "advisory",
          instructionPath,
        });
      } catch (error) {
        return fail(
          `Skill-bench apply disabled for ${id}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
    }
    const persistedOutput = {
      ...output,
      scope: effectiveScope,
      applied: !dryRun && routeStatePath !== null,
      instructionPath:
        instructionPath === null
          ? null
          : displayPath(context.cwd, instructionPath),
      routeStatePath:
        routeStatePath === null
          ? null
          : displayPath(context.cwd, routeStatePath),
      activation:
        instructionPath === null ? null : "new Copilot CLI session required",
    };
    return context.json
      ? { ok: true, output: persistedOutput }
      : {
          ok: true,
          message: `${dryRun ? "dry-run " : ""}apply plan for ${id}: capability=${output.capability} verified=${plan.verified} enforced=${plan.enforced} mutations=${plan.mutations.length} disabled=${plan.disabledReason ?? "none"}${conflictDetails ? `\nconflicts: ${conflictDetails}` : ""}${instructionPath ? `\ninstructions: ${persistedOutput.instructionPath}\nactivation: ${persistedOutput.activation}` : ""}${routeStatePath ? `\nrouting-state: ${persistedOutput.routeStatePath}` : ""}`,
        };
  }
  if (sub === "export") {
    const id = requireId(
      args,
      "omp skill-bench export <spec-id-or-run-id> --output <path> [--approve]",
    );
    if (typeof id !== "string") return id;
    const outputIndex = args.indexOf("--output");
    if (
      outputIndex === -1 ||
      !args[outputIndex + 1] ||
      args[outputIndex + 1].startsWith("--")
    )
      return fail(
        "Missing export output. Usage: omp skill-bench export <spec-id-or-run-id> --output <path> [--approve].",
      );
    const approve = args.includes("--approve");
    const strayAllowed = new Set([
      "--output",
      args[outputIndex + 1],
      "--approve",
    ]);
    const stray = rejectStray(args, strayAllowed, 2);
    if (stray) return stray;
    const artifact = loadExportableSpecOrRun(id, context.cwd);
    if (isCliFailure(artifact)) return artifact;
    const outputPath = args[outputIndex + 1];
    const files = exportManifestFiles(artifact.artifact);
    if (files.length === 0)
      return fail(
        `Privacy preflight failed: ${id}: missing export manifest files.`,
      );
    const paths = resolveSkillBenchPaths({ cwd: context.cwd });
    const scope = artifactScope(paths, artifact.path);
    const exportFiles = readExportFiles(
      files,
      paths,
      scope,
      path.dirname(artifact.path),
    );
    if ("ok" in exportFiles) return exportFiles;
    const preflight = preflightSkillBenchExport({ files: exportFiles });
    if (!preflight.ok)
      return fail(`Privacy preflight failed: ${preflight.errors.join("; ")}.`);
    const prepared = preparePortableExport({
      id,
      artifact,
      paths,
      scope,
      outputPath,
      cwd: context.cwd,
      exportFiles,
      preflightFiles: preflight.files,
    });
    if (isCliFailure(prepared)) return prepared;
    if (!approve) {
      writeJsonFile(
        prepared.previewPath,
        prepared.preview,
        artifact.trustedRoot,
      );
      const persistedPreview = loadJsonFile(
        prepared.previewPath,
        artifact.trustedRoot,
      );
      if (canonicalJson(persistedPreview) !== canonicalJson(prepared.preview)) {
        return fail(
          `Portable export ${prepared.exportId} preview failed verification.`,
        );
      }
      return context.json
        ? { ok: true, output: prepared.preview }
        : {
            ok: true,
            message: `portable export preview ready for ${id}\npreview: ${displayPath(context.cwd, prepared.previewPath)}\noutput: ${outputPath}\nprivacy preflight passed; ${exportFiles.length} files reviewed; redactions=0\napproval required: ${String(prepared.preview.nextCommand)}`,
          };
    }
    if (!existsSync(prepared.previewPath)) {
      return fail(
        `Portable export ${prepared.exportId} preview required; rerun without --approve and review the included files first.`,
      );
    }
    let persistedPreview: unknown;
    try {
      persistedPreview = loadJsonFile(
        prepared.previewPath,
        artifact.trustedRoot,
      );
    } catch {
      return fail(
        `Portable export ${prepared.exportId} preview is invalid; rerun without --approve.`,
      );
    }
    if (canonicalJson(persistedPreview) !== canonicalJson(prepared.preview)) {
      return fail(
        `Portable export ${prepared.exportId} preview is stale; rerun without --approve and review the changed files.`,
      );
    }
    ensureDir(prepared.approvalLedgerPath);
    const approvalFailure = recordExportApproval(
      prepared.approvalLedgerPath,
      artifact.trustedRoot,
      prepared.exportId,
      prepared.approvalSha256,
      id,
      artifact.kind,
    );
    if (approvalFailure) return approvalFailure;
    if (!existsSync(path.dirname(prepared.outputAbsolute)))
      return fail("Portable export output directory must already exist.");
    try {
      atomicWriteTrustedFile(prepared.outputAbsolute, prepared.bundleText, {
        rejectHardlinks: true,
        trustedRoot: prepared.outputTrustedRoot,
      });
    } catch (error) {
      return fail(
        `Portable export output could not be written safely: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    const written = readRegularFileUtf8(
      prepared.outputAbsolute,
      prepared.outputTrustedRoot,
    );
    if (!written.ok)
      return fail("Portable export output could not be rebound safely.");
    const writtenSha256 = createHash("sha256")
      .update(written.content)
      .digest("hex");
    if (writtenSha256 !== prepared.bundleSha256) {
      return fail(
        `Portable export ${prepared.exportId} failed output integrity verification.`,
      );
    }
    return context.json
      ? { ok: true, output: prepared.output }
      : {
          ok: true,
          message: `portable export bundle written for ${id}: ${outputPath}\nexport-id=${prepared.exportId}\nprivacy preflight and approval passed; ${exportFiles.length} files embedded with sha256 integrity`,
        };
  }
  return fail(
    `Unknown skill-bench subcommand: ${sub}. See: omp skill-bench --help.`,
  );
}

export const skillBenchCommand: CommandModule = {
  name: "skill-bench",
  summary:
    "skill-bench [<skill-or-path>] [design flags] [--probe-models]; resume [<draft-id>] [--import|--approve|--freeze]; run <spec-id-or-path> --pilot|--validated [--approve-spend]; report; rerun; apply; export <spec-id-or-run-id> [--approve]",
  async run(argv, context): Promise<CliResult> {
    const args = stripCommand(argv);
    if (args[0] === "--help" || args[0] === "-h")
      return { ok: true, message: HELP };
    try {
      if (
        ["resume", "run", "report", "rerun", "apply", "export"].includes(
          args[0] ?? "",
        )
      )
        return runSubcommand(args, context);
      const parsed = parseDesign(args);
      const output = persistDesign(
        await designOutput(parsed, context.cwd),
        context.cwd,
      );
      return context.json
        ? { ok: true, output }
        : { ok: true, message: formatDesign(output, context.cwd) };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
