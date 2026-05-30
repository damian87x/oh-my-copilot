import { buildSynthPrompt, parseSynthOutput } from "./prompts.js";
import type {
  CouncilDeps,
  CouncilMemberResult,
  CouncilPerMemberSummary,
  CouncilSynthOutput,
  CouncilTaskSpec,
  ResolvedCouncilConfig,
} from "./types.js";

export interface SynthesizeResult {
  ok: boolean;
  synth?: CouncilSynthOutput;
  rawStdout?: string;
  rawStderr?: string;
  error?: string;
}

function buildPerMemberSummary(
  members: CouncilMemberResult[],
): CouncilPerMemberSummary[] {
  return members.map((r) => ({
    model: r.spec.model,
    role: r.spec.role,
    weight: r.spec.weight,
    verdict: r.output?.verdict ?? "",
    confidence: r.output?.confidence ?? 0,
    dropped: r.status !== "ok",
    dropReason: r.status !== "ok" ? r.dropReason : undefined,
  }));
}

/**
 * Run the synthesizer over surviving members. Never fabricates a verdict: if the
 * synth call fails or is unparseable, returns ok:false with the raw output.
 * The returned synth's per_member_summary is authoritatively rebuilt from ALL
 * members (including dropped ones) so the model can't omit a dropped member.
 */
export async function synthesize(
  config: ResolvedCouncilConfig,
  spec: CouncilTaskSpec,
  allMembers: CouncilMemberResult[],
  deps: CouncilDeps,
): Promise<SynthesizeResult> {
  const survivors = allMembers.filter((m) => m.status === "ok");
  const prompt = buildSynthPrompt(config, spec, survivors);

  let res;
  try {
    res = await deps.spawn({
      model: config.synthesizerModel,
      prompt,
      timeoutMs: config.perMemberTimeoutMs,
    });
  } catch (err) {
    return { ok: false, error: `synth spawn failed: ${String(err)}` };
  }

  if (res.timedOut) {
    return { ok: false, rawStdout: res.stdout, rawStderr: res.stderr, error: "synth timed out" };
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      rawStdout: res.stdout,
      rawStderr: res.stderr,
      error: `synth exited ${res.exitCode}`,
    };
  }

  const parsed = parseSynthOutput(res.stdout);
  if (!parsed) {
    return {
      ok: false,
      rawStdout: res.stdout,
      rawStderr: res.stderr,
      error: "synth output unparseable",
    };
  }

  // Authoritative summary from engine-side member records.
  parsed.per_member_summary = buildPerMemberSummary(allMembers);
  return { ok: true, synth: parsed, rawStdout: res.stdout, rawStderr: res.stderr };
}
