/**
 * Interactive `omp config set memory-mode on` flow.
 *
 * Enabling memory review is the moment to make sure a usable model is
 * configured — otherwise reviews fail silently every session (see index.ts).
 * So we: (interactive) probe candidate models, show which the plan can actually
 * run, prompt for a choice (default gpt-5-mini); validate the choice by probing;
 * REJECT without saving if it's entitlement-unavailable; persist mode+model to
 * the GLOBAL ~/.omp config (a user preference, like `git user.email`).
 *
 * All I/O and model probing is injected so this is unit-testable without a TTY
 * or a real copilot subprocess.
 */
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  KNOWN_MODEL_SLUGS,
  probeModel,
  probeModels,
  type ProbeResult,
} from "../copilot/models.js";
import { DEFAULT_MEMBERS } from "../council/config.js";
import type { CouncilSpawn } from "../council/types.js";
import {
  readMemoryConfig,
  setMemoryConfigValues,
  unsetMemoryConfigValue,
} from "./config.js";

export interface EnableIO {
  print(line: string): void;
  /** One line of input, or undefined when non-interactive / stream closed. */
  ask(prompt: string): Promise<string | undefined>;
}

export interface EnableMemoryOptions {
  cwd: string;
  homeDir?: string;
  /** Show the model picker. Caller computes via isInteractive(json). */
  interactive: boolean;
  /** Probe the chosen model before saving. False under --no-validate. */
  validate: boolean;
  spawn: CouncilSpawn;
  io: EnableIO;
  /** From a `--model <slug>` flag; skips the prompt's default. */
  explicitModel?: string;
  probeTimeoutMs?: number;
}

export interface EnableMemoryResult {
  ok: boolean;
  model?: string;
  message: string;
}

/** Candidates to probe/offer: curated list + the configured model + council defaults. */
function candidateSlugs(configured: string): string[] {
  return Array.from(
    new Set([...KNOWN_MODEL_SLUGS, configured, ...DEFAULT_MEMBERS.map((m) => m.model)]),
  );
}

export async function enableMemoryMode(opts: EnableMemoryOptions): Promise<EnableMemoryResult> {
  const { cwd, homeDir, interactive, validate, spawn, io } = opts;
  const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const configured = readMemoryConfig(cwd, { homeDir }).memoryReviewModel; // gpt-5-mini by default
  const candidates = candidateSlugs(configured);

  // Default applied on an empty answer: an explicit --model, else the currently
  // configured model (which itself defaults to gpt-5-mini). Pressing Enter must
  // never silently switch the user off their configured model.
  const def = opts.explicitModel ?? configured;
  let chosen = def;
  let probed: ProbeResult[] | undefined;

  if (interactive) {
    let offered = candidates;
    if (validate) {
      io.print("Probing models (checks which your plan can actually run)…");
      probed = await probeModels(spawn, candidates, { timeoutMs });
      const available = probed.filter((r) => r.status === "available").map((r) => r.model);
      const unavailable = probed.filter((r) => r.status === "unavailable").map((r) => r.model);
      const unknown = probed.filter((r) => r.status === "unknown").map((r) => r.model);
      offered = available;
      if (available.length) {
        io.print("Available models:");
        available.forEach((m, i) => io.print(`  ${i + 1}) ${m}`));
      } else {
        io.print("(could not confirm any model — you can still type a slug)");
      }
      if (unavailable.length) io.print(`Not available on your plan: ${unavailable.join(", ")}`);
      if (unknown.length) io.print(`Unverified: ${unknown.join(", ")}`);
    } else {
      io.print("Candidate models:");
      candidates.forEach((m, i) => io.print(`  ${i + 1}) ${m}`));
    }

    const answer = ((await io.ask(`Review model [${def}]: `)) ?? "").trim();
    if (!answer) {
      chosen = def;
    } else if (/^\d+$/.test(answer)) {
      const idx = Number(answer) - 1;
      if (idx < 0 || idx >= offered.length) {
        return {
          ok: false,
          message: `invalid selection '${answer}' — choose 1-${offered.length} or type a model slug`,
        };
      }
      chosen = offered[idx];
    } else {
      chosen = answer;
    }
  }

  if (validate) {
    // Reuse the picker's probe when we already have it; else probe just the pick.
    const known = probed?.find((r) => r.model === chosen);
    const status = known?.status ?? (await probeModel(spawn, chosen, timeoutMs)).status;
    if (status === "unavailable") {
      return {
        ok: false,
        message: `model '${chosen}' is not available — pick another (run: omp models)`,
      };
    }
    if (status === "unknown") {
      // Offline / transient — can't prove it's bad, so don't block enabling.
      io.print(`Warning: could not verify '${chosen}' (offline?) — saving anyway; run 'omp models' later.`);
    }
  }

  setMemoryConfigValues(
    cwd,
    { memoryMode: "on", memoryReviewModel: chosen },
    { scope: "global", homeDir },
  );
  // A stale PROJECT memoryMode would shadow the global write (project wins in the
  // merge), silently defeating enable — drop it so global is authoritative.
  unsetMemoryConfigValue(cwd, "memoryMode", { scope: "project" });
  return {
    ok: true,
    model: chosen,
    message: `memory-mode=on, review model=${chosen} (global ~/.omp)`,
  };
}
