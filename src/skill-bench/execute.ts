import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCopilotBin } from "../copilot/launch.js";

export type FailureClassV1 =
  | "quality"
  | "process"
  | "infrastructure"
  | "availability"
  | "quota"
  | "scorer"
  | "incomplete"
  | "parity-invalid";

export interface BudgetStopReason {
  family: "budget";
  detail: "usd-ceiling" | "premium-ceiling" | "runtime-ceiling" | "cell-ceiling";
}

export interface ExecutionProfileConfig {
  kind: "restricted" | "normal" | "normal-project" | "custom";
  customInstructions?: string | null;
  allowlistedTools?: string[];
}

export interface MatchedCellPlan {
  runId: string;
  scenarioId: string;
  task: string;
  visibleFixtureFingerprint: string;
  modelId: string;
  permissions: string[];
  timeoutMs: number;
  contextFingerprint: string;
  seed: string;
  workspaceSource: { kind: string; fingerprint: string; sourcePath?: string };
  executionProfile: ExecutionProfileConfig;
  selectedSkillId: string;
  selectedSkillPath?: string | null;
  selectedSkillFingerprint?: string | null;
  promptArm?: { approved: boolean; prompt: string };
  runRoot: string;
  workspaceRoot?: string;
  hiddenAssets?: Record<string, unknown>;
}

export interface SkillExposure {
  selectedSkillId: string | null;
  requiredTool?: "skill";
  sourcePath?: string;
  fingerprint?: string;
  exposurePath?: string;
  prompt: string | null;
}

export interface ExecutionCell {
  id: string;
  arm: "baseline" | "skill" | "prompt";
  runId: string;
  scenarioId: string;
  task: string;
  visibleFixtureFingerprint: string;
  modelId: string;
  permissions: string[];
  timeoutMs: number;
  contextFingerprint: string;
  seed: string;
  workspaceSource: { kind: string; fingerprint: string };
  workspaceSourcePath?: string;
  executionProfile: ExecutionProfileConfig;
  workspacePath: string;
  skillExposure: SkillExposure;
}

export interface CandidateRequest {
  schemaVersion: 1;
  cellId: string;
  task: string;
  visibleFixtureFingerprint: string;
  modelId: string;
  permissions: string[];
  timeoutMs: number;
  contextFingerprint: string;
  seed: string;
  workspaceSource: { kind: string; fingerprint: string };
  workspacePath: string;
  skillExposure: SkillExposure;
  executionProfile: { kind: ExecutionProfileConfig["kind"]; customInstructions: string | null; allowlistedTools: string[] };
}

export interface SkillBenchProviderTransportResult {
  status: "complete" | "unavailable" | "quota" | "timeout" | "error";
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
  evaluation?: {
    qualityScore: number;
    proofMatrix: {
      expected: string[];
      found: string[];
      done: string[];
      missed: string[];
      falsePositive: string[];
      incorrect: string[];
      proof: string[];
    };
  };
}

export type SkillBenchProviderTransport = (
  request: CandidateRequest,
) => Promise<SkillBenchProviderTransportResult>;

let testProviderTransport: SkillBenchProviderTransport | null = null;

export function setSkillBenchProviderTransportForTests(
  transport: SkillBenchProviderTransport | null,
): void {
  testProviderTransport = transport;
}

export function currentSkillBenchProviderTransport(): SkillBenchProviderTransport {
  return testProviderTransport ?? copilotProviderTransport;
}

export const PROVIDER_TRANSPORT_FINGERPRINT = "copilot-headless-argv-v2";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export function createProviderWorkspaceRoot(runId: string): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "run";
  return mkdtempSync(path.join(realpathSync(tmpdir()), `omp-skill-bench-${safeRunId}-`));
}

export function buildMatchedExecutionCells(plan: MatchedCellPlan): ExecutionCell[] {
  validateProfile(plan.executionProfile);
  const arms: Array<ExecutionCell["arm"]> = ["baseline", "skill"];
  if (plan.promptArm?.approved) arms.push("prompt");
  return arms.map((arm) => ({
    id: `${plan.runId}-${plan.scenarioId}-${arm}`,
    arm,
    runId: plan.runId,
    scenarioId: plan.scenarioId,
    task: plan.task,
    visibleFixtureFingerprint: plan.visibleFixtureFingerprint,
    modelId: plan.modelId,
    permissions: [...plan.permissions],
    timeoutMs: plan.timeoutMs,
    contextFingerprint: plan.contextFingerprint,
    seed: plan.seed,
    workspaceSource: {
      kind: plan.workspaceSource.kind,
      fingerprint: plan.workspaceSource.fingerprint,
    },
    workspaceSourcePath: plan.workspaceSource.sourcePath,
    executionProfile: { ...plan.executionProfile, allowlistedTools: [...(plan.executionProfile.allowlistedTools ?? [])] },
    workspacePath: path.join(plan.workspaceRoot ?? plan.runRoot, "workspaces", `${plan.scenarioId}-${arm}-${plan.seed}`),
    skillExposure:
      arm === "baseline"
        ? { selectedSkillId: null, prompt: null }
        : arm === "skill"
          ? {
              selectedSkillId: plan.selectedSkillId,
              sourcePath: plan.selectedSkillPath ?? undefined,
              fingerprint: plan.selectedSkillFingerprint ?? undefined,
              requiredTool: "skill",
              prompt: null,
            }
          : { selectedSkillId: null, prompt: plan.promptArm?.prompt ?? null },
  }));
}

export function buildCandidateRequest(cell: ExecutionCell): CandidateRequest {
  const restricted = cell.executionProfile.kind === "restricted";
  return {
    schemaVersion: 1,
    cellId: cell.id,
    task: cell.task,
    visibleFixtureFingerprint: cell.visibleFixtureFingerprint,
    modelId: cell.modelId,
    permissions: [...cell.permissions],
    timeoutMs: cell.timeoutMs,
    contextFingerprint: cell.contextFingerprint,
    seed: cell.seed,
    workspaceSource: { ...cell.workspaceSource },
    workspacePath: cell.workspacePath,
    skillExposure: { ...cell.skillExposure },
    executionProfile: {
      kind: cell.executionProfile.kind,
      customInstructions: restricted ? null : (cell.executionProfile.customInstructions ?? null),
      allowlistedTools: [...(cell.executionProfile.allowlistedTools ?? [])],
    },
  };
}

export async function copilotProviderTransport(
  request: CandidateRequest,
): Promise<SkillBenchProviderTransportResult> {
  const bin = resolveCopilotBin();
  const args = providerArgv(request);
  return new Promise<SkillBenchProviderTransportResult>((resolveFn) => {
    const child = spawn(bin, args, {
      cwd: request.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: providerEnvironment(request),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = request.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn({
        status: "error",
        stdout,
        stderr: stderr || String(error),
        exitCode: 127,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timedOut = signal === "SIGTERM";
      const session = readCopilotSessionTelemetry(request);
      const usage = parseCopilotJsonUsage(
        session ? `${stdout}\n${session.rawEvents}` : stdout,
      );
      if (usage && session) {
        usage.completeness =
          typeof usage.inputTokens === "number" &&
          typeof usage.outputTokens === "number"
            ? "provider-session-json"
            : "partial-provider-session-json";
        usage.provenance = "copilot-session-events";
      }
      let status: SkillBenchProviderTransportResult["status"] = "error";
      if (timedOut) {
        status = "timeout";
      } else if (code === 0 || stdout.trim()) {
        status = "complete";
      }
      resolveFn({
        status,
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : timedOut ? 124 : null,
        usage,
        sessionTelemetry:
          session && usage
            ? {
                schemaVersion: 1,
                source: "copilot-session-events",
                eventType: "session.shutdown",
                sourceSha256: session.sourceSha256,
                usage,
              }
            : undefined,
      });
    });
  });
}

function providerArgv(request: CandidateRequest): string[] {
  const args = [
    "--model",
    request.modelId,
    "--no-auto-update",
    "--no-ask-user",
    "--no-remote",
    "--no-remote-export",
    "--output-format",
    "json",
  ];
  if (request.executionProfile.kind === "restricted") args.push("--no-custom-instructions");
  const availableTools = [
    ...new Set([
      ...request.executionProfile.allowlistedTools,
      ...(request.skillExposure.requiredTool
        ? [request.skillExposure.requiredTool]
        : []),
    ]),
  ];
  if (availableTools.length > 0) {
    args.push("--available-tools", availableTools.join(","));
    for (const tool of availableTools) args.push("--allow-tool", tool);
  }
  args.push("-p", providerPrompt(request));
  return args;
}

function providerEnvironment(request: CandidateRequest): NodeJS.ProcessEnv {
  const copilotHome = providerCopilotHome(request);
  mkdirSync(copilotHome, { recursive: true });
  writeFileSync(
    path.join(copilotHome, "config.json"),
    `${JSON.stringify({ trustedFolders: [request.workspacePath] }, null, 2)}\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMP_MEMORY_MODE: "off",
    COPILOT_HOME: copilotHome,
  };
  if (
    !env.COPILOT_GITHUB_TOKEN &&
    !env.GH_TOKEN &&
    !env.GITHUB_TOKEN &&
    !env.COPILOT_PROVIDER_BASE_URL
  ) {
    const token = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (token.status === 0 && token.stdout.trim()) {
      env.COPILOT_GITHUB_TOKEN = token.stdout.trim();
    }
  }
  return env;
}

function providerCopilotHome(request: CandidateRequest): string {
  return path.join(request.workspacePath, ".omp-copilot-home");
}

function readCopilotSessionTelemetry(
  request: CandidateRequest,
): { rawEvents: string; sourceSha256: string } | undefined {
  const sessionRoot = path.join(providerCopilotHome(request), "session-state");
  if (!existsSync(sessionRoot) || lstatSync(sessionRoot).isSymbolicLink())
    return undefined;
  const files: string[] = [];
  for (const entry of readdirSync(sessionRoot).sort()) {
    const candidate = path.join(sessionRoot, entry, "events.jsonl");
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (stats.isFile() && !stats.isSymbolicLink()) files.push(candidate);
  }
  if (files.length === 0) return undefined;
  const rawEvents = files.map((file) => readFileSync(file, "utf8")).join("\n");
  if (!rawEvents.split(/\r?\n/).some((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown };
      return event.type === "session.shutdown";
    } catch {
      return false;
    }
  })) return undefined;
  return {
    rawEvents,
    sourceSha256: createHash("sha256").update(rawEvents).digest("hex"),
  };
}

export function parseCopilotJsonUsage(stdout: string): Record<string, unknown> | undefined {
  const maxima = new Map<string, number>();
  const aliases: Record<string, string> = {
    inputtokens: "inputTokens",
    input_tokens: "inputTokens",
    prompttokens: "inputTokens",
    prompt_tokens: "inputTokens",
    outputtokens: "outputTokens",
    output_tokens: "outputTokens",
    completiontokens: "outputTokens",
    completion_tokens: "outputTokens",
    totaltokens: "totalTokens",
    total_tokens: "totalTokens",
    cachereadtokens: "cacheReadTokens",
    cache_read_tokens: "cacheReadTokens",
    cachedinputtokens: "cacheReadTokens",
    cached_input_tokens: "cacheReadTokens",
    cachewritetokens: "cacheWriteTokens",
    cache_write_tokens: "cacheWriteTokens",
    premiumrequests: "premiumRequests",
    premium_requests: "premiumRequests",
    totalpremiumrequests: "premiumRequests",
    total_premium_requests: "premiumRequests",
    totalnanoaiu: "totalNanoAiu",
    total_nano_aiu: "totalNanoAiu",
    costusd: "costUsd",
    cost_usd: "costUsd",
    reasoningtokens: "reasoningTokens",
    reasoning_tokens: "reasoningTokens",
    durationms: "durationMs",
    duration_ms: "durationMs",
    totalapidurationms: "durationMs",
    total_api_duration_ms: "durationMs",
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const canonical = aliases[key.toLowerCase()];
      if (canonical && typeof child === "number" && Number.isFinite(child) && child >= 0) {
        maxima.set(canonical, Math.max(maxima.get(canonical) ?? 0, child));
      }
      visit(child);
    }
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // Text output remains valid evidence; it simply has no structured usage.
    }
  }
  if (maxima.size === 0) return undefined;
  const providerReportedTotal = maxima.has("totalTokens");
  if (
    !maxima.has("totalTokens") &&
    maxima.has("inputTokens") &&
    maxima.has("outputTokens")
  ) {
    maxima.set(
      "totalTokens",
      (maxima.get("inputTokens") ?? 0) + (maxima.get("outputTokens") ?? 0),
    );
  }
  const usage = Object.fromEntries(maxima);
  const totalNanoAiu = maxima.get("totalNanoAiu");
  const directAiCreditCost =
    totalNanoAiu === undefined
      ? {}
      : {
          totalNanoAiu,
          aiCredits: Number((totalNanoAiu / 1_000_000_000).toFixed(9)),
          ...(maxima.has("costUsd")
            ? {}
            : {
                costUsd: Number(
                  (totalNanoAiu / 100_000_000_000).toFixed(12),
                ),
              }),
        };
  const complete = maxima.has("inputTokens") && maxima.has("outputTokens");
  return {
    ...usage,
    ...directAiCreditCost,
    ...(maxima.has("totalTokens")
      ? {
          totalProvenance: providerReportedTotal
            ? "provider-reported"
            : "derived-input-plus-output",
        }
      : {}),
    completeness: complete ? "provider-json" : "partial-provider-json",
    provenance: "copilot-json-output",
  };
}

function providerPrompt(request: CandidateRequest): string {
  const skillLine = request.skillExposure.selectedSkillId
    ? `Invoke /${request.skillExposure.selectedSkillId} before completing the task, then follow the loaded skill exactly.`
    : "Do not use a benchmarked skill.";
  const promptLine = request.skillExposure.prompt
    ? `Approved prompt guidance: ${request.skillExposure.prompt}`
    : "";
  return [
    "You are executing one approved skill-bench cell.",
    request.executionProfile.customInstructions ? `Approved custom instructions: ${request.executionProfile.customInstructions}` : "",
    skillLine,
    promptLine,
    `Task: ${request.task}`,
  ].filter(Boolean).join("\n");
}

export function ensureProviderWorkspace(cell: ExecutionCell): void {
  rmSync(cell.workspacePath, { recursive: true, force: true });
  mkdirSync(cell.workspacePath, { recursive: true });
  if (cell.workspaceSourcePath) {
    if (!existsSync(cell.workspaceSourcePath)) {
      throw new Error("visible fixture source is missing");
    }
    const sourceFingerprint = fingerprintSkillDirectory(cell.workspaceSourcePath);
    if (sourceFingerprint !== cell.workspaceSource.fingerprint) {
      throw new Error("visible fixture source fingerprint is stale");
    }
    for (const reserved of [
      path.join(cell.workspaceSourcePath, ".github", "skills"),
      path.join(cell.workspaceSourcePath, ".omp-copilot-home"),
    ]) {
      if (existsSync(reserved)) {
        throw new Error("visible fixture contains a reserved skill-bench path");
      }
    }
    for (const entry of readdirSync(cell.workspaceSourcePath).sort()) {
      cpSync(
        path.join(cell.workspaceSourcePath, entry),
        path.join(cell.workspacePath, entry),
        { recursive: true, force: false, dereference: false },
      );
    }
    if (fingerprintSkillDirectory(cell.workspacePath) !== cell.workspaceSource.fingerprint) {
      throw new Error("prepared workspace fixture fingerprint mismatch");
    }
  }
  const projectSkills = path.join(cell.workspacePath, ".github", "skills");
  rmSync(projectSkills, { recursive: true, force: true });
  rmSync(path.join(cell.workspacePath, ".omp-copilot-home"), {
    recursive: true,
    force: true,
  });
  if (!cell.skillExposure.selectedSkillId) return;
  if (!cell.skillExposure.sourcePath || !cell.skillExposure.fingerprint) {
    throw new Error("selected skill exposure requires frozen source path and fingerprint");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cell.skillExposure.selectedSkillId)) {
    throw new Error("selected skill id is unsafe");
  }
  if (!existsSync(cell.skillExposure.sourcePath)) {
    throw new Error("selected skill source is missing");
  }
  const sourceFingerprint = fingerprintSkillDirectory(cell.skillExposure.sourcePath);
  if (sourceFingerprint !== cell.skillExposure.fingerprint) {
    throw new Error("selected skill source fingerprint is stale");
  }
  const target = path.join(projectSkills, cell.skillExposure.selectedSkillId);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(cell.skillExposure.sourcePath, target, {
    recursive: true,
    force: false,
    dereference: false,
  });
  if (fingerprintSkillDirectory(target) !== cell.skillExposure.fingerprint) {
    rmSync(target, { recursive: true, force: true });
    throw new Error("staged skill fingerprint mismatch");
  }
  cell.skillExposure.exposurePath = target;
}

export function fingerprintSkillDirectory(directory: string): string {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
    throw new Error("skill source must be a real directory");
  }
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const entryPath = path.join(current, entry);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) throw new Error("skill source contains symlink");
      if (stats.isDirectory()) visit(entryPath);
      else if (stats.isFile()) files.push(entryPath);
    }
  };
  visit(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(path.relative(directory, file).split(path.sep).join("/"))
      .update("\0")
      .update(readFileSync(file))
      .update("\0");
  }
  return hash.digest("hex");
}

export interface EstimatedCellCost {
  usd?: number;
  premiumRequests?: number;
  runtimeMs?: number;
}

const DEFAULT_ESTIMATED_CELL_USD = 0.01;
const DEFAULT_ESTIMATED_PREMIUM_REQUESTS = 1;

export function scheduleCellsWithinCeilings(
  cells: ExecutionCell[],
  state: {
    spentUsd: number;
    premiumRequests: number;
    runtimeMs: number;
    startedCells: number;
    ceilings: { maxUsd: number; maxPremiumRequests: number; maxRuntimeMs: number; maxCells: number };
    estimatedCell?: EstimatedCellCost;
    retryPolicy: { maxAttempts: number; retryInfrastructure: boolean };
  },
): { cellsToStart: ExecutionCell[]; stopReason: BudgetStopReason | null; retryPolicy: { maxAttempts: number; retryInfrastructure: boolean; frozen: true } } {
  const retryPolicy = { ...state.retryPolicy, frozen: true as const };
  if (state.spentUsd >= state.ceilings.maxUsd) return { cellsToStart: [], stopReason: { family: "budget", detail: "usd-ceiling" }, retryPolicy };
  if (state.premiumRequests >= state.ceilings.maxPremiumRequests) return { cellsToStart: [], stopReason: { family: "budget", detail: "premium-ceiling" }, retryPolicy };
  if (state.runtimeMs >= state.ceilings.maxRuntimeMs) return { cellsToStart: [], stopReason: { family: "budget", detail: "runtime-ceiling" }, retryPolicy };
  if (state.startedCells >= state.ceilings.maxCells) return { cellsToStart: [], stopReason: { family: "budget", detail: "cell-ceiling" }, retryPolicy };

  const estimatedCell = resolveEstimatedCellCost(cells, state.estimatedCell);
  const nextCellCount = cells.length;
  if (state.spentUsd + estimatedCell.usd * nextCellCount > state.ceilings.maxUsd) return { cellsToStart: [], stopReason: { family: "budget", detail: "usd-ceiling" }, retryPolicy };
  if (state.premiumRequests + estimatedCell.premiumRequests * nextCellCount > state.ceilings.maxPremiumRequests) {
    return { cellsToStart: [], stopReason: { family: "budget", detail: "premium-ceiling" }, retryPolicy };
  }
  if (state.runtimeMs + estimatedCell.runtimeMs * nextCellCount > state.ceilings.maxRuntimeMs) return { cellsToStart: [], stopReason: { family: "budget", detail: "runtime-ceiling" }, retryPolicy };
  if (state.startedCells + nextCellCount > state.ceilings.maxCells) return { cellsToStart: [], stopReason: { family: "budget", detail: "cell-ceiling" }, retryPolicy };
  return { cellsToStart: [...cells], stopReason: null, retryPolicy };
}

function resolveEstimatedCellCost(cells: ExecutionCell[], estimate: EstimatedCellCost | undefined): Required<EstimatedCellCost> {
  return {
    usd: estimate?.usd ?? DEFAULT_ESTIMATED_CELL_USD,
    premiumRequests: estimate?.premiumRequests ?? DEFAULT_ESTIMATED_PREMIUM_REQUESTS,
    runtimeMs: estimate?.runtimeMs ?? Math.max(0, ...cells.map((cell) => cell.timeoutMs)),
  };
}

export const REQUIRED_EVIDENCE_ARTIFACTS = [
  "request.json",
  "response.json",
  "result.json",
  "diff.patch",
  "tests.txt",
  "transcript.txt",
  "usage.json",
  "scorer.json",
  "timestamps.json",
] as const;

export function finalizeEvidenceBundle(root: string): { status: "complete" | "incomplete-evidence"; missingArtifacts: string[] } {
  const missingArtifacts = REQUIRED_EVIDENCE_ARTIFACTS.filter((artifact) => !existsSync(path.join(root, artifact)));
  if (missingArtifacts.length > 0) return { status: "incomplete-evidence", missingArtifacts };
  writeFileSync(path.join(root, "COMPLETE"), "complete\n");
  return { status: "complete", missingArtifacts: [] };
}

export function classifyCellFailure(input: {
  timeout?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  partialOutput?: boolean;
  unavailable?: boolean;
  quotaExceeded?: boolean;
  scorerFailure?: boolean;
  incompleteEvidence?: boolean;
  parityInvalid?: boolean;
  skillNotApplied?: boolean;
  evaluatorLabel?: FailureClassV1;
}): FailureClassV1 {
  if (input.parityInvalid) return "parity-invalid";
  if (input.incompleteEvidence) return "incomplete";
  if (input.scorerFailure) return "scorer";
  if (input.quotaExceeded) return "quota";
  if (input.unavailable) return "availability";
  if (input.timeout || input.signal || input.partialOutput) return "infrastructure";
  if (input.exitCode !== undefined && input.exitCode !== 0) return "infrastructure";
  if (input.skillNotApplied) return "process";
  return input.evaluatorLabel ?? "quality";
}

function validateProfile(profile: ExecutionProfileConfig): void {
  if (!["restricted", "normal", "normal-project", "custom"].includes(profile.kind)) throw new Error("unknown execution profile");
  if (profile.kind === "restricted" && (profile.allowlistedTools ?? []).length === 0) throw new Error("restricted profile requires allowlisted tools");
}
