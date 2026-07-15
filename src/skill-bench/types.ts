import { createHash } from "node:crypto";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type SpecStatusV1 = "draft" | "approved" | "frozen";
export type ExecutionProfileV1 = "restricted" | "normal-project" | "custom";
export type ScenarioActionV1 = "detect-report" | "propose" | "implement-verify" | "plan-only";
export type ArmKindV1 = "baseline" | "skill" | "prompt";

export interface SkillBenchArmV1 {
  id: string;
  kind: ArmKindV1;
  skillId?: string;
}

export interface SkillBenchScenarioV1 {
  id: string;
  name: string;
  action: ScenarioActionV1;
  tags: string[];
  weight: number;
  threshold: { min: number; max: number; pass: number };
}

export interface SkillBenchSpecV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  status: SpecStatusV1;
  executionProfile: ExecutionProfileV1;
  budgets: Record<string, number>;
  candidateModelIds: string[];
  judgeModelIds: string[];
  arms: SkillBenchArmV1[];
  scenarios: SkillBenchScenarioV1[];
}

export interface ApprovalBindingV1 {
  schemaVersion: 1;
  specHash: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;
const SPEC_STATUSES = new Set(["draft", "approved", "frozen"]);
const EXECUTION_PROFILES = new Set(["restricted", "normal-project", "custom"]);
const ACTIONS = new Set(["detect-report", "propose", "implement-verify", "plan-only"]);
const ARM_KINDS = new Set(["baseline", "skill", "prompt"]);
const RUN_STATUSES = new Set(["draft", "approved", "frozen", "running", "complete", "failed", "cancelled"]);
const EVIDENCE_STATUSES = new Set([
  "complete",
  "quality-failure",
  "process-failure",
  "infrastructure-failure",
  "availability-failure",
  "quota-failure",
  "scorer-failure",
  "incomplete",
  "parity-invalid",
]);
const SUMMARY_STATUSES = new Set(["winner", "tie", "inconclusive", "failed"]);
const RECOMMENDATION_ACTIONS = new Set(["none", "enforced", "advisory", "unsupported"]);
const RECOMMENDATION_STATUSES = new Set(["ready", "stale", "blocked", "unsupported"]);
const SCENARIO_WEIGHT_TOTAL = 1;
const SCENARIO_WEIGHT_TOTAL_TOLERANCE = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushSafeId(errors: string[], label: string, value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    errors.push(`unsafe ${label}`);
    return false;
  }
  return true;
}

function pushSafeModelId(errors: string[], label: string, value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_MODEL_ID.test(value)) {
    errors.push(`unsafe ${label}`);
    return false;
  }
  return true;
}

function pushSafeName(errors: string[], label: string, value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    errors.push(`unsafe ${label}`);
    return false;
  }
  return true;
}

function validateUniqueIds(errors: string[], label: string, items: unknown[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== "string") {
      errors.push(`missing ${label} id`);
      continue;
    }
    if (!SAFE_ID.test(item.id)) errors.push(`unsafe ${label} id`);
    if (seen.has(item.id)) errors.push(`duplicate ${label} id`);
    seen.add(item.id);
  }
}

function expectNumber(errors: string[], message: string, value: unknown, options: { positive?: boolean; nonNegative?: boolean } = {}): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(message);
    return false;
  }
  if (options.positive && value <= 0) errors.push(message);
  if (options.nonNegative && value < 0) errors.push(message);
  return true;
}

function validateScenarioTags(errors: string[], value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("missing scenario tags");
    return;
  }
  const seen = new Set<string>();
  for (const tag of value) {
    if (typeof tag !== "string" || !SAFE_ID.test(tag)) {
      errors.push("unsafe scenario tag");
      continue;
    }
    if (seen.has(tag)) errors.push("duplicate scenario tag");
    seen.add(tag);
  }
}

export function validateSkillBenchSpecV1(input: unknown): ValidationResult<SkillBenchSpecV1> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["spec must be an object"] };
  if (input.schemaVersion !== 1) errors.push("unsupported schema version");
  pushSafeId(errors, "spec id", input.id);
  pushSafeName(errors, "spec name", input.name);
  if (typeof input.status !== "string" || !SPEC_STATUSES.has(input.status)) errors.push("unknown spec status");
  if (typeof input.executionProfile !== "string" || !EXECUTION_PROFILES.has(input.executionProfile)) errors.push("unknown execution profile");

  if (!isRecord(input.budgets)) {
    errors.push("missing budgets");
  } else {
    for (const [key, value] of Object.entries(input.budgets)) expectNumber(errors, `invalid budget ${key}`, value, { nonNegative: true });
  }

  const candidateModelIds = Array.isArray(input.candidateModelIds) ? input.candidateModelIds : [];
  const judgeModelIds = Array.isArray(input.judgeModelIds) ? input.judgeModelIds : [];
  if (!Array.isArray(input.candidateModelIds) || candidateModelIds.length === 0) errors.push("missing candidate model ids");
  if (!Array.isArray(input.judgeModelIds) || judgeModelIds.length === 0) errors.push("missing judge model ids");
  for (const id of candidateModelIds) pushSafeModelId(errors, "candidate model id", id);
  for (const id of judgeModelIds) pushSafeModelId(errors, "judge model id", id);
  const judges = new Set(judgeModelIds.filter((id): id is string => typeof id === "string"));
  for (const id of candidateModelIds) if (typeof id === "string" && judges.has(id)) errors.push("candidate model cannot judge itself");

  const arms = Array.isArray(input.arms) ? input.arms : [];
  if (!Array.isArray(input.arms)) errors.push("missing arms");
  validateUniqueIds(errors, "arm", arms);
  const armKinds = new Set<string>();
  for (const arm of arms) {
    if (!isRecord(arm)) continue;
    if (typeof arm.kind !== "string" || !ARM_KINDS.has(arm.kind)) errors.push("unknown arm kind");
    else armKinds.add(arm.kind);
    if (arm.kind === "skill") pushSafeId(errors, "skill id", arm.skillId);
  }
  if (!armKinds.has("baseline") || !armKinds.has("skill")) errors.push("baseline and skill arms are mandatory");

  const scenarios = Array.isArray(input.scenarios) ? input.scenarios : [];
  if (!Array.isArray(input.scenarios) || scenarios.length === 0) errors.push("missing scenarios");
  validateUniqueIds(errors, "scenario", scenarios);
  let scenarioWeightTotal = 0;
  let validScenarioWeights = 0;
  for (const scenario of scenarios) {
    if (!isRecord(scenario)) continue;
    pushSafeName(errors, "scenario name", scenario.name);
    if (typeof scenario.action !== "string" || !ACTIONS.has(scenario.action)) errors.push("unknown scenario action");
    validateScenarioTags(errors, scenario.tags);
    if (expectNumber(errors, "invalid scenario weight", scenario.weight, { positive: true })) {
      scenarioWeightTotal += scenario.weight;
      validScenarioWeights += 1;
    }
    if (!isRecord(scenario.threshold)) {
      errors.push("missing threshold");
    } else {
      const min = scenario.threshold.min;
      const max = scenario.threshold.max;
      const pass = scenario.threshold.pass;
      const minOk = expectNumber(errors, "impossible threshold", min);
      const maxOk = expectNumber(errors, "impossible threshold", max);
      const passOk = expectNumber(errors, "impossible threshold", pass);
      if (minOk && maxOk && passOk && !(min <= pass && pass <= max && min < max)) {
        errors.push("impossible threshold");
      }
    }
  }
  if (scenarios.length > 0 && validScenarioWeights === scenarios.length && Math.abs(scenarioWeightTotal - SCENARIO_WEIGHT_TOTAL) > SCENARIO_WEIGHT_TOTAL_TOLERANCE) {
    errors.push("invalid scenario weight total");
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as SkillBenchSpecV1 };
}

function validatePrimitive(input: unknown, kind: string, statuses: Set<string>): ValidationResult<Record<string, unknown>> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: [`${kind} must be an object`] };
  if (input.schemaVersion !== 1) errors.push("unsupported schema version");
  pushSafeId(errors, `${kind} id`, input.id);
  if (typeof input.status !== "string" || !statuses.has(input.status)) errors.push(`unknown ${kind} status`);
  return errors.length ? { ok: false, errors } : { ok: true, value: input };
}

export function validateRunV1(input: unknown): ValidationResult<Record<string, unknown>> {
  const result = validatePrimitive(input, "run", RUN_STATUSES);
  if (!result.ok) return result;
  const errors: string[] = [];
  pushSafeId(errors, "spec id", result.value.specId);
  if (!Array.isArray(result.value.cells)) errors.push("missing cells");
  return errors.length ? { ok: false, errors } : result;
}

export function validateEvidenceV1(input: unknown): ValidationResult<Record<string, unknown>> {
  const result = validatePrimitive(input, "evidence", EVIDENCE_STATUSES);
  if (!result.ok) return result;
  const errors: string[] = [];
  pushSafeId(errors, "cell id", result.value.cellId);
  if (!Array.isArray(result.value.paths)) errors.push("missing evidence paths");
  return errors.length ? { ok: false, errors } : result;
}

export function validateSummaryV1(input: unknown): ValidationResult<Record<string, unknown>> {
  const result = validatePrimitive(input, "summary", SUMMARY_STATUSES);
  if (!result.ok) return result;
  const errors: string[] = [];
  pushSafeId(errors, "run id", result.value.runId);
  return errors.length ? { ok: false, errors } : result;
}

export function validateRecommendationV1(input: unknown): ValidationResult<Record<string, unknown>> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["recommendation must be an object"] };
  if (input.schemaVersion !== 1) errors.push("unsupported schema version");
  pushSafeId(errors, "recommendation id", input.id);
  pushSafeId(errors, "run id", input.runId);
  if (typeof input.action !== "string" || !RECOMMENDATION_ACTIONS.has(input.action)) errors.push("unknown recommendation action");
  if (typeof input.status !== "string" || !RECOMMENDATION_STATUSES.has(input.status)) errors.push("unknown recommendation status");
  return errors.length ? { ok: false, errors } : { ok: true, value: input };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
    return out;
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function specContentForHash(spec: unknown): unknown {
  if (!isRecord(spec)) return spec;
  // Lifecycle metadata is derived from the approval ledger. Excluding it keeps
  // gate approvals bound to the semantic experiment while allowing freeze to
  // transition draft -> frozen without manufacturing a new content hash.
  const {
    approvals: _approvals,
    approvalLedger: _approvalLedger,
    status: _status,
    ...content
  } = spec;
  return content;
}

export function specContentHash(spec: unknown): string {
  return stableHash(specContentForHash(spec));
}

export function bindApprovalHash(spec: unknown): ApprovalBindingV1 {
  return { schemaVersion: 1, specHash: specContentHash(spec) };
}

export function isApprovalBoundToSpec(binding: { specHash?: string }, spec: unknown): boolean {
  return binding.specHash === specContentHash(spec);
}

export function isFreezeInvalidated(freeze: { specHash?: string; frozenPairIds?: string[] }, spec: unknown, pairIds: string[] = []): boolean {
  return freeze.specHash !== specContentHash(spec) || canonicalJson(freeze.frozenPairIds ?? []) !== canonicalJson([...pairIds].sort());
}
