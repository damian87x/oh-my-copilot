import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveCopilotBin } from "../copilot/launch.js";
import { runCouncil, type RunCouncilOptions } from "./engine.js";
import type {
  CouncilDeps,
  CouncilRunResult,
  CouncilSpawn,
  CouncilTaskSpec,
  SpawnRequest,
  SpawnResponse,
} from "./types.js";

export * from "./types.js";
export {
  loadCouncilConfig,
  readCouncilFileConfig,
  DEFAULT_MEMBERS,
  DEFAULT_SYNTHESIZER,
  DEFAULT_MIN_SURVIVORS,
  DEFAULT_PER_MEMBER_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENCY,
} from "./config.js";
export {
  buildMemberPrompt,
  buildSynthPrompt,
  parseMemberOutput,
  parseSynthOutput,
  extractJsonCandidates,
  balancedBlocks,
  isValidMemberOutput,
  isValidSynthOutput,
} from "./prompts.js";
export { runCouncil, runWithConcurrency, type ProgressCallback } from "./engine.js";
export { synthesize } from "./synth.js";

/**
 * Default member invoker: spawn `copilot --model <model> -p <prompt> --allow-all-tools`
 * with PIPED stdio so we can capture stdout. Uses resolveCopilotBin() so the
 * OMP_COPILOT_BIN stub-bin test seam works. Does NOT route through launchCopilot
 * (that tmux-wraps and inherits stdio, which would discard the model's output).
 */
export function createDefaultSpawn(bin?: string): CouncilSpawn {
  const copilotBin = resolveCopilotBin(bin);
  return (req: SpawnRequest): Promise<SpawnResponse> =>
    new Promise<SpawnResponse>((resolveFn) => {
      const child = spawn(
        copilotBin,
        ["--model", req.model, "-p", req.prompt, "--allow-all-tools"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, req.timeoutMs);

      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveFn({ stdout, stderr, exitCode: 127, timedOut });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveFn({
          stdout,
          stderr,
          exitCode: typeof code === "number" ? code : timedOut ? 124 : 1,
          timedOut,
        });
      });
    });
}

/** Default deps: real spawn + fs artifact writer (mkdir -p on demand). */
export function createDefaultDeps(bin?: string): CouncilDeps {
  return {
    spawn: createDefaultSpawn(bin),
    now: () => Date.now(),
    writeArtifact: (path: string, data: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data, "utf8");
    },
  };
}

/** Convenience entry for the CLI: run the council with the real default deps. */
export async function runCouncilWithDefaults(
  spec: CouncilTaskSpec,
  options: RunCouncilOptions & { bin?: string } = {},
): Promise<CouncilRunResult> {
  const { bin, ...rest } = options;
  return runCouncil(spec, createDefaultDeps(bin), rest);
}
