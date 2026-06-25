import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCouncilConfig, type LoadCouncilConfigOptions } from "./config.js";
import { buildMemberPrompt, parseMemberOutput } from "./prompts.js";
import { synthesize } from "./synth.js";
import { isModelUnavailable as isUnavailable } from "./types.js";
import type {
  CouncilDeps,
  CouncilMemberResult,
  CouncilMemberSpec,
  CouncilMemberStatus,
  CouncilRunResult,
  CouncilTaskSpec,
  ResolvedCouncilConfig,
  SpawnResponse,
} from "./types.js";

export type ProgressCallback = (message: string) => void;

/**
 * Run `worker` over `items` with at most `limit` in flight. The slot is released
 * in a finally block so a rejected/errored worker frees its slot too (otherwise
 * a rejection would deadlock the queue for subsequent items). Results preserve
 * input order. Worker rejections are reflected as rejected result promises, so
 * callers should make `worker` non-throwing (we do).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));

  async function runner(): Promise<void> {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      try {
        results[current] = await worker(items[current], current);
      } finally {
        // slot is freed simply by looping to the next item
      }
    }
  }

  const runners: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function classify(res: SpawnResponse): {
  status: CouncilMemberStatus;
  dropReason?: string;
} {
  if (res.timedOut) return { status: "timeout", dropReason: "member timed out" };
  if (isUnavailable(res)) {
    return { status: "unavailable", dropReason: "model not available to this Copilot plan" };
  }
  if (res.exitCode !== 0) {
    return { status: "error", dropReason: `member exited ${res.exitCode}` };
  }
  return { status: "ok" };
}

async function runMember(
  spec: CouncilMemberSpec,
  index: number,
  taskSpec: CouncilTaskSpec,
  config: ResolvedCouncilConfig,
  deps: CouncilDeps,
  tmpDir: string,
): Promise<CouncilMemberResult> {
  const prompt = buildMemberPrompt(taskSpec, spec);
  const started = (deps.now ?? Date.now)();
  let res: SpawnResponse;
  try {
    res = await deps.spawn({ model: spec.model, prompt, timeoutMs: config.perMemberTimeoutMs });
  } catch (err) {
    return {
      spec,
      status: "error",
      durationMs: 0,
      dropReason: `spawn failed: ${String(err)}`,
    };
  }
  const durationMs = (deps.now ?? Date.now)() - started;

  let { status, dropReason } = classify(res);
  let output;
  if (status === "ok" || status === "timeout") {
    const parsed = parseMemberOutput(res.stdout);
    if (parsed) {
      // Upgrade timed-out members that produced valid output before the kill.
      if (status === "timeout") {
        status = "ok";
        dropReason = undefined;
      }
      output = parsed;
    } else if (status === "ok") {
      status = "unparseable";
      dropReason = "no schema-valid JSON in output";
    }
    // timeout with no parseable output stays "timeout"
  }

  const jsonPath = join(tmpDir, `m${index}.json`);
  const artifact = output ?? { rawStdout: res.stdout, rawStderr: res.stderr, status };
  if (deps.writeArtifact) {
    try {
      deps.writeArtifact(jsonPath, JSON.stringify(artifact, null, 2));
    } catch {
      // artifact write is best-effort; ignore failures
    }
  }

  return {
    spec,
    status,
    output,
    rawStdout: res.stdout,
    rawStderr: res.stderr,
    exitCode: res.exitCode,
    durationMs,
    dropReason,
    jsonPath,
  };
}

/**
 * Opt-in preflight probe: cheaply ping each DISTINCT model and prune only those
 * that report "unavailable" (exit + stderr signature). A slow/timed-out probe is
 * NOT treated as unavailable, so reachable-but-slow models are kept.
 */
async function probeRoster(
  members: CouncilMemberSpec[],
  config: ResolvedCouncilConfig,
  deps: CouncilDeps,
): Promise<{ kept: CouncilMemberSpec[]; pruned: { model: string; reason: string }[] }> {
  const distinct = Array.from(new Set(members.map((m) => m.model)));
  const probeTimeout = Math.min(15000, config.perMemberTimeoutMs);
  const verdicts = await runWithConcurrency(distinct, config.maxConcurrency, async (model) => {
    try {
      const res = await deps.spawn({ model, prompt: "Reply with: ok", timeoutMs: probeTimeout });
      return { model, unavailable: isUnavailable(res) };
    } catch {
      return { model, unavailable: false }; // spawn error != entitlement problem
    }
  });
  const unavailable = new Set(verdicts.filter((v) => v.unavailable).map((v) => v.model));
  const kept = members.filter((m) => !unavailable.has(m.model));
  const pruned = members
    .filter((m) => unavailable.has(m.model))
    .map((m) => ({ model: m.model, reason: "model not available to this Copilot plan" }));
  return { kept, pruned };
}

export interface RunCouncilOptions extends LoadCouncilConfigOptions {
  onProgress?: ProgressCallback;
}

/**
 * Fan a question out to the council, parse + classify each member, then
 * synthesize from survivors. Degrades gracefully: drops timed-out / unavailable /
 * errored / unparseable members and synthesizes from the rest; fails only if
 * fewer than `minSurvivors` survive.
 */
export async function runCouncil(
  spec: CouncilTaskSpec,
  deps: CouncilDeps,
  options: RunCouncilOptions = {},
): Promise<CouncilRunResult> {
  const config = loadCouncilConfig(spec, options);
  const now = deps.now ?? Date.now;
  const tmpDir = spec.tmpDir ?? join(tmpdir(), `council-${now()}`);
  const progress = options.onProgress;

  let roster = config.members;
  const prunedResults: CouncilMemberResult[] = [];

  if (config.probe) {
    progress?.(`Probing ${roster.length} model(s)…`);
    const { kept, pruned } = await probeRoster(roster, config, deps);
    roster = kept;
    for (const p of pruned) {
      const spc = config.members.find((m) => m.model === p.model);
      if (spc) {
        progress?.(`  ✗ ${spc.model} (${spc.role}): unavailable`);
        prunedResults.push({
          spec: spc,
          status: "unavailable",
          durationMs: 0,
          dropReason: p.reason,
        });
      }
    }
  }

  progress?.(`Running ${roster.length} member(s)…`);
  let completed = 0;
  const ran = await runWithConcurrency(roster, config.maxConcurrency, async (member, i) => {
    const result = await runMember(member, i, spec, config, deps, tmpDir);
    completed++;
    const dur = (result.durationMs / 1000).toFixed(1);
    if (result.status === "ok") {
      progress?.(`  ✓ ${completed}/${roster.length} ${member.model} (${member.role}) ${dur}s`);
    } else {
      progress?.(`  ✗ ${completed}/${roster.length} ${member.model} (${member.role}) ${result.status} ${dur}s`);
    }
    return result;
  });

  const members = [...ran, ...prunedResults];
  const survivors = members.filter((m) => m.status === "ok");
  const dropped = members.length - survivors.length;

  if (survivors.length < config.minSurvivors) {
    const unavailableModels = members
      .filter((m) => m.status === "unavailable")
      .map((m) => m.spec.model);
    const detail =
      unavailableModels.length > 0
        ? ` Unavailable models: ${unavailableModels.join(", ")}.`
        : "";
    return {
      ok: false,
      members,
      survivors: survivors.length,
      dropped,
      tmpDir,
      error: `too few surviving members (${survivors.length}/${config.minSurvivors}).${detail}`,
    };
  }

  progress?.(`Synthesizing from ${survivors.length} survivor(s)…`);
  const synthResult = await synthesize(config, spec, members, deps);
  if (!synthResult.ok || !synthResult.synth) {
    return {
      ok: false,
      members,
      survivors: survivors.length,
      dropped,
      tmpDir,
      error: synthResult.error ?? "synthesis failed",
    };
  }

  return {
    ok: true,
    synth: synthResult.synth,
    members,
    survivors: survivors.length,
    dropped,
    tmpDir,
  };
}
