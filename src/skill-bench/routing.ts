export type RoutingCapabilityV1 = "enforced" | "advisory" | "unsupported";
export type RoutingScope = "project" | "global";

export interface DesiredRouteV1 {
  skillId: string;
  modelId: string;
}

export interface RoutingRecommendationV1 {
  schemaVersion: 1;
  id: string;
  runId: string;
  validated: boolean;
  humanApprovedPolicy: string | null;
  scope: RoutingScope;
  taskMatcher: string;
  objective?: string;
  selectedSkill: { id: string; fingerprint: string };
  selectedModel: { id: string; fingerprint: string };
  fingerprints: { spec: string; evaluation: string; provider: string; pricing?: string };
  confidence: { verdict: string; samples: number; scenarioCoverage: string };
  evidencePath: string;
}

export interface RoutingSurfaceInput {
  surface: string;
  provider: string;
  ownedLaunch: boolean;
  supportsEnforcedRoute: boolean;
  capturedEffectiveRoute: DesiredRouteV1 & { evidencePath: string } | null;
  unsupportedReason?: string;
}

export interface RoutingCapabilityEntryV1 {
  surface: string;
  capability: RoutingCapabilityV1;
  reason: string;
  desiredRoute: DesiredRouteV1;
  effectiveRoute: DesiredRouteV1 | null;
  verified: boolean;
  verificationEvidence: string | null;
}

export interface RouteRule {
  scope: RoutingScope;
  taskMatcher: string;
  skillId: string;
  modelId: string;
  source: string;
}

export interface RouteApplyPlan {
  dryRun: boolean;
  verified: boolean;
  enforced: boolean;
  disabledReason: string | null;
  conflicts: RouteRule[];
  precedence: string[];
  mutations: string[];
  memoryUsedAsSourceOfTruth: false;
  bypassDisclosed: boolean;
}

const PRECEDENCE = ["explicit task", "project", "global", "host default"];
const BEGIN = "<!-- BEGIN OMP SKILL-BENCH ROUTE -->";
const END = "<!-- END OMP SKILL-BENCH ROUTE -->";

export function buildRoutingCapabilityProtocolV1(input: { recommendation: RoutingRecommendationV1; surfaces: RoutingSurfaceInput[] }): RoutingCapabilityEntryV1[] {
  assertRecommendationSource(input.recommendation);
  const desiredRoute = desiredRouteFromRecommendation(input.recommendation);
  return input.surfaces.map((surface) => {
    if (surface.unsupportedReason) {
      return unsupported(surface.surface, surface.unsupportedReason, desiredRoute);
    }
    if (surface.provider === "copilot" && surface.surface.includes("interactive")) {
      return {
        surface: surface.surface,
        capability: "advisory",
        reason: "Copilot interactive v1 cannot be enforced after session start",
        desiredRoute,
        effectiveRoute: null,
        verified: false,
        verificationEvidence: null,
      };
    }
    if (surface.ownedLaunch && surface.provider === "omp" && surface.supportsEnforcedRoute && surface.capturedEffectiveRoute && routesEqual(desiredRoute, surface.capturedEffectiveRoute)) {
      return {
        surface: surface.surface,
        capability: "enforced",
        reason: "OMP-owned launch captured effective route",
        desiredRoute,
        effectiveRoute: { skillId: surface.capturedEffectiveRoute.skillId, modelId: surface.capturedEffectiveRoute.modelId },
        verified: true,
        verificationEvidence: surface.capturedEffectiveRoute.evidencePath,
      };
    }
    return {
      surface: surface.surface,
      capability: "advisory",
      reason: "provider route cannot be verified as enforced by OMP",
      desiredRoute,
      effectiveRoute: null,
      verified: false,
      verificationEvidence: null,
    };
  });
}

export function planSkillBenchRouteApply(input: {
  recommendation: RoutingRecommendationV1;
  dryRun: boolean;
  currentFingerprints: { skill: string; model: string; spec: string; evaluation: string; provider: string };
  existingRules: RouteRule[];
  routingCapabilities?: RoutingCapabilityEntryV1[];
  requestedScope?: RoutingScope;
  explicitBypass?: boolean;
}): RouteApplyPlan {
  assertRecommendationSource(input.recommendation);
  const stale = staleReasons(input.recommendation, input.currentFingerprints);
  const scope = input.requestedScope ?? input.recommendation.scope ?? "project";
  const conflicts = input.existingRules.filter((rule) => rule.scope === scope && rule.taskMatcher === input.recommendation.taskMatcher && (rule.skillId !== input.recommendation.selectedSkill.id || rule.modelId !== input.recommendation.selectedModel.id));
  const hasVerifiedEffectiveRoute = hasVerifiedOmpEffectiveRoute(input.recommendation, input.routingCapabilities ?? []);
  const hasCopilotAdvisoryRoute = hasCopilotAdvisoryCapability(
    input.recommendation,
    input.routingCapabilities ?? [],
  );
  let disabledReason: string | null = null;
  if (stale.length) {
    disabledReason = `stale fingerprint: ${stale.join(", ")}`;
  } else if (conflicts.length) {
    disabledReason = "conflicting route already exists";
  } else if (!input.dryRun && !hasVerifiedEffectiveRoute && !hasCopilotAdvisoryRoute) {
    disabledReason = "missing verified OMP effective route evidence or Copilot advisory capability";
  }
  return {
    dryRun: input.dryRun,
    verified: disabledReason === null && !input.dryRun && hasVerifiedEffectiveRoute,
    enforced: disabledReason === null && !input.dryRun && hasVerifiedEffectiveRoute,
    disabledReason,
    conflicts,
    precedence: [...PRECEDENCE],
    mutations:
      disabledReason || hasVerifiedEffectiveRoute || !hasCopilotAdvisoryRoute
        ? []
        : [`write ${scope} advisory route for ${input.recommendation.taskMatcher}`],
    memoryUsedAsSourceOfTruth: false,
    bypassDisclosed: input.explicitBypass === true,
  };
}

export function renderAdvisoryInstructionBlock(recommendation: RoutingRecommendationV1, existingContent = ""): string {
  assertRecommendationSource(recommendation);
  assertValidMarkerTopology(existingContent);
  const block = [
    BEGIN,
    `Recommended skill: ${recommendation.selectedSkill.id}`,
    `Recommended model: ${recommendation.selectedModel.id}`,
    `Task matcher: ${recommendation.taskMatcher}`,
    `Evidence: ${recommendation.evidencePath}`,
    `Run: ${recommendation.runId}`,
    `Safety gate: run \`omp skill-bench apply ${recommendation.runId} --dry-run\`; ignore this route unless it reports disabled=none.`,
    END,
  ].join("\n");
  if (!existingContent) return block;
  const pattern = new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}`, "m");
  if (pattern.test(existingContent)) return existingContent.replace(pattern, block);
  return `${existingContent.replace(/\s+$/, "")}\n${block}`;
}

export function parseAdvisoryInstructionRoute(
  existingContent: string,
  scope: RoutingScope,
  source = "copilot-instructions",
): RouteRule | null {
  assertValidMarkerTopology(existingContent);
  if (!existingContent.includes(BEGIN)) return null;
  const block = new RegExp(
    `${escapeRegExp(BEGIN)}([\\s\\S]*?)${escapeRegExp(END)}`,
    "m",
  ).exec(existingContent)?.[1];
  if (block === undefined)
    throw new Error("invalid skill-bench route marker topology");
  const field = (label: string): string | null => {
    const match = new RegExp(
      `^${escapeRegExp(label)}: (.+)$`,
      "m",
    ).exec(block);
    return match?.[1]?.trim() || null;
  };
  const skillId = field("Recommended skill");
  const modelId = field("Recommended model");
  const taskMatcher = field("Task matcher");
  if (!skillId || !modelId || !taskMatcher) {
    throw new Error(
      "skill-bench route marker is missing required route fields",
    );
  }
  return { scope, taskMatcher, skillId, modelId, source };
}

export function resolveSkillBenchRoute(input: { taskMatcher: string; explicitTaskRoute?: RouteRule | null; projectRules: RouteRule[]; globalRules: RouteRule[] }): RouteRule | null {
  if (input.explicitTaskRoute) return input.explicitTaskRoute;
  const project = input.projectRules.find((rule) => rule.taskMatcher === input.taskMatcher);
  if (project) return project;
  const global = input.globalRules.find((rule) => rule.taskMatcher === input.taskMatcher);
  return global ?? null;
}

export function preflightSkillBenchExport(input: { files: Array<{ path: string; content: string; symlinkTarget?: string | null }> }): { ok: true; files: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const file of input.files) {
    if (/(RAW_PROMPT_SENTINEL|RAW_OUTPUT_SENTINEL)/.test(file.content)) errors.push(`${file.path}: raw prompt/output sentinel`);
    if (/\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|019[a-f0-9]{5,}-[a-f0-9-]{20,})\b/i.test(file.content)) errors.push(`${file.path}: session id`);
    if (/(?:^|\s)\/(?:Users|home)\/[^\s]+/.test(file.content)) errors.push(`${file.path}: absolute private path`);
    if (/(?:sk|ghp|github_pat|xox[baprs])-[-_A-Za-z0-9]{6,}/.test(file.content) || /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/.test(file.content)) errors.push(`${file.path}: secret`);
    if (file.symlinkTarget) errors.push(`${file.path}: unresolved symlink`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, files: input.files.map((file) => file.path) };
}

function unsupported(surface: string, reason: string, desiredRoute: DesiredRouteV1): RoutingCapabilityEntryV1 {
  return { surface, capability: "unsupported", reason, desiredRoute, effectiveRoute: null, verified: false, verificationEvidence: null };
}

function desiredRouteFromRecommendation(recommendation: RoutingRecommendationV1): DesiredRouteV1 {
  return { skillId: recommendation.selectedSkill.id, modelId: recommendation.selectedModel.id };
}

function routesEqual(a: DesiredRouteV1, b: DesiredRouteV1): boolean {
  return a.skillId === b.skillId && a.modelId === b.modelId;
}

function hasVerifiedOmpEffectiveRoute(recommendation: RoutingRecommendationV1, capabilities: RoutingCapabilityEntryV1[]): boolean {
  const desiredRoute = desiredRouteFromRecommendation(recommendation);
  return capabilities.some((entry) =>
    entry.capability === "enforced"
    && entry.verified
    && entry.reason === "OMP-owned launch captured effective route"
    && entry.verificationEvidence !== null
    && entry.effectiveRoute !== null
    && routesEqual(desiredRoute, entry.desiredRoute)
    && routesEqual(desiredRoute, entry.effectiveRoute)
  );
}

function hasCopilotAdvisoryCapability(
  recommendation: RoutingRecommendationV1,
  capabilities: RoutingCapabilityEntryV1[],
): boolean {
  const desiredRoute = desiredRouteFromRecommendation(recommendation);
  return capabilities.some(
    (entry) =>
      entry.capability === "advisory" &&
      entry.surface.includes("copilot") &&
      routesEqual(desiredRoute, entry.desiredRoute),
  );
}

function assertValidMarkerTopology(content: string): void {
  const begins = content.split(BEGIN).length - 1;
  const ends = content.split(END).length - 1;
  if ((begins === 0 && ends === 0) || (begins === 1 && ends === 1)) return;
  throw new Error(
    "skill-bench advisory instruction markers are corrupt or duplicated",
  );
}

function assertRecommendationSource(recommendation: RoutingRecommendationV1): void {
  if (recommendation.validated) return;
  if (recommendation.humanApprovedPolicy && ["tie", "inconclusive"].includes(recommendation.confidence.verdict)) return;
  throw new Error("recommendation requires validated evidence or explicit human-approved tie/inconclusive policy");
}

function staleReasons(recommendation: RoutingRecommendationV1, current: { skill: string; model: string; spec: string; evaluation: string; provider: string }): string[] {
  const stale: string[] = [];
  if (recommendation.selectedSkill.fingerprint !== current.skill) stale.push("skill");
  if (recommendation.selectedModel.fingerprint !== current.model) stale.push("model");
  if (recommendation.fingerprints.spec !== current.spec) stale.push("spec");
  if (recommendation.fingerprints.evaluation !== current.evaluation) stale.push("evaluation");
  if (recommendation.fingerprints.provider !== current.provider) stale.push("provider");
  return stale;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
