import { runWithConcurrency } from "../council/engine.js";
import { isModelUnavailable } from "../council/types.js";
import type { CouncilSpawn } from "../council/types.js";

/**
 * Model-availability probing for Copilot. There is no headless way to ENUMERATE
 * models (copilot has no list-models command; `/model` is TUI-only; the
 * api.githubcopilot.com/models endpoint is plan-gated and wrong under BYOK), so
 * discovery is done by PROBING candidate slugs — which tests the only thing that
 * matters: "will `--model <slug>` actually run?". That works under BYOK too.
 */

/**
 * Curated candidate slugs to probe by default. Last updated: 2026-06-25. Copilot
 * has no model-listing API, so this is hand-maintained; keep it small. Replace
 * with a dynamic source if/when copilot exposes one. `--candidates` and the
 * configured model cover anything missing here.
 */
export const KNOWN_MODEL_SLUGS: readonly string[] = [
  "gpt-5-mini",
  "gpt-4.1",
  "claude-haiku-4.5",
  "claude-sonnet-4.5",
  "gemini-2.5-pro",
];

export type ProbeStatus = "available" | "unavailable" | "unknown";

export interface ProbeResult {
  model: string;
  status: ProbeStatus;
}

/** Default probe timeout. copilot's headless `-p` mode frequently prints its
 *  answer but does NOT exit promptly, so a working model is detected by captured
 *  stdout (below) rather than a clean exit — the timeout just bounds the wait. */
export const DEFAULT_PROBE_TIMEOUT_MS = 12000;

/**
 * Probe one model with a trivial prompt and classify:
 *  - the entitlement signature on stderr → `unavailable` (fast, reliable),
 *  - any captured stdout OR a clean exit → `available` (the model answered;
 *    we accept stdout even on timeout because `copilot -p` often hangs after
 *    replying instead of exiting),
 *  - otherwise (no output: timeout/crash/spawn error) → `unknown` (can't prove
 *    it's bad — "slow/broken != not entitled").
 */
export async function probeModel(
  spawn: CouncilSpawn,
  model: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let res;
  try {
    res = await spawn({ model, prompt: "Reply with: ok", timeoutMs });
  } catch {
    return { model, status: "unknown" };
  }
  if (isModelUnavailable(res)) return { model, status: "unavailable" };
  if (res.stdout.trim().length > 0) return { model, status: "available" };
  if (res.exitCode === 0 && !res.timedOut) return { model, status: "available" };
  return { model, status: "unknown" };
}

/**
 * Probe several models concurrently. De-dupes slugs first. NOTE: parallels
 * council's probeRoster (engine.ts) which probes CouncilMemberSpec[]; kept
 * separate because the input/return shapes differ — unify if a 3rd caller appears.
 */
export async function probeModels(
  spawn: CouncilSpawn,
  slugs: string[],
  opts: { maxConcurrency?: number; timeoutMs?: number } = {},
): Promise<ProbeResult[]> {
  const distinct = Array.from(new Set(slugs));
  return runWithConcurrency(distinct, opts.maxConcurrency ?? 4, (model) =>
    probeModel(spawn, model, opts.timeoutMs),
  );
}
