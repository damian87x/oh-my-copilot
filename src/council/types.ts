// Type contracts for the weighted-consensus model council.
// See docs/plans / .omp/plans/weighted-consensus.md for the authoritative design.

/** One council member: a model running under a role with a prior weight. */
export interface CouncilMemberSpec {
  model: string; // copilot --model slug, e.g. "claude-haiku-4.5", "gpt-5-mini", "auto"
  role: string; // e.g. "critic", "architect", "pragmatist"
  weight: number; // prior/hint, positive; normalized for display only
}

/** The task the council answers. Generic so /code-review etc. can reuse it. */
export interface CouncilTaskSpec {
  question: string; // the shared question every member answers
  context?: string; // optional shared context (diff, file excerpt, ...)
  rubric?: string; // optional evaluation rubric (used by /code-review caller)
  rolePack?: string; // optional named role-pack id to expand into members[]
  members?: CouncilMemberSpec[]; // explicit roster override (else config -> default)
  minSurvivors?: number; // min parsed members required to synthesize (default 2)
  perMemberTimeoutMs?: number; // default from config (default 120000)
  synthTimeoutMs?: number; // synth timeout; default 2× perMemberTimeoutMs
  synthesizerModel?: string; // override synth model
  probe?: boolean; // opt-in preflight availability probe; default false. Precedence: spec.probe (CLI --probe) ?? config.probe ?? false
  maxConcurrency?: number; // max parallel member spawns (default 4); hand-rolled limiter
  tmpDir?: string; // override temp dir root (default <os.tmpdir()>/council-<ts>)
}

/** What each member MUST emit (the member JSON contract). */
export interface CouncilMemberOutput {
  verdict: string; // member's answer/recommendation (short)
  confidence: number; // 0..1 self-assessed confidence
  rationale: string; // why (concise, evidence-first)
  risks?: string[]; // optional risks/caveats
  dissent?: string; // optional: where it expects to disagree with others
}

/** Per-member runtime classification. "unavailable" is distinct from "error". */
export type CouncilMemberStatus =
  | "ok"
  | "timeout"
  | "error"
  | "unavailable"
  | "unparseable";

/** Per-member runtime result (engine-internal, surfaced in --json). */
export interface CouncilMemberResult {
  spec: CouncilMemberSpec;
  status: CouncilMemberStatus;
  output?: CouncilMemberOutput; // present iff status === "ok"
  rawStdout?: string;
  rawStderr?: string;
  exitCode?: number;
  durationMs: number;
  dropReason?: string; // human-readable reason when not "ok"
  jsonPath?: string; // <os.tmpdir()>/council-<ts>/m<i>.json
}

export interface CouncilPerMemberSummary {
  model: string;
  role: string;
  weight: number;
  verdict: string;
  confidence: number;
  dropped: boolean;
  dropReason?: string;
}

/** Synthesizer output schema (final verdict). */
export interface CouncilSynthOutput {
  verdict: string;
  confidence: number; // 0..1
  rationale: string; // weights as priors, evidence can override
  minority_report: string; // notable dissent worth surfacing ("" if none)
  per_member_summary: CouncilPerMemberSummary[];
}

/** Top-level engine result (what runCouncil returns / cli prints). */
export interface CouncilRunResult {
  ok: boolean;
  synth?: CouncilSynthOutput;
  members: CouncilMemberResult[];
  survivors: number;
  dropped: number;
  tmpDir: string;
  error?: string; // set when ok === false
}

/** Resolved configuration after merging spec > config > built-in default. */
export interface ResolvedCouncilConfig {
  members: CouncilMemberSpec[];
  synthesizerModel: string;
  minSurvivors: number;
  perMemberTimeoutMs: number;
  synthTimeoutMs: number;
  maxConcurrency: number;
  probe: boolean;
}

// ---- Dependency-injection seam (THE testability boundary) ----
export interface SpawnRequest {
  model: string;
  prompt: string;
  timeoutMs: number;
}
export interface SpawnResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
/** Real impl spawns `copilot --model <model> -p <prompt>`; tests inject a fake. */
export type CouncilSpawn = (req: SpawnRequest) => Promise<SpawnResponse>;

/** stderr signature copilot emits when a --model slug is not entitled to the plan. */
export const UNAVAILABLE_SIGNATURE = /is not available/i;

/**
 * True only for an entitlement failure (model not available to this plan), not a
 * transient crash/timeout. Lives here (a leaf module) so both the council and
 * the copilot model-probing utilities share one detector without a cycle.
 */
export function isModelUnavailable(res: SpawnResponse): boolean {
  return res.exitCode !== 0 && !res.timedOut && UNAVAILABLE_SIGNATURE.test(res.stderr);
}

export interface CouncilDeps {
  spawn: CouncilSpawn; // injectable model invoker
  now?: () => number; // injectable clock (timestamps / temp dir)
  writeArtifact?: (path: string, data: string) => void; // default fs write
}
