import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CouncilMemberSpec,
  CouncilTaskSpec,
  ResolvedCouncilConfig,
} from "./types.js";

export const DEFAULT_MIN_SURVIVORS = 2;
export const DEFAULT_PER_MEMBER_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Built-in default roster. Uses ONLY gpt-5-mini — the cheap, included model
 * (no premium request) that effectively every Copilot plan can run — so the
 * council works out of the box without entitlement errors. Diversity here
 * comes from the per-member ROLE prompts, not the model.
 *
 * Do NOT hardcode a premium model in this default: it breaks the council for
 * anyone whose plan lacks it (gpt-4.1 used to be here and is no longer broadly
 * available). For real multi-model diversity, override in .omp/config.json
 * `council` or inline via --models. Run `omp models` to see which slugs your
 * plan can actually use (e.g. claude-sonnet-4.6, gpt-5.4, gemini-3.1-pro-preview),
 * then list those.
 */
export const DEFAULT_MEMBERS: CouncilMemberSpec[] = [
  { model: "gpt-5-mini", role: "critic", weight: 0.4 },
  { model: "gpt-5-mini", role: "architect", weight: 0.35 },
  { model: "gpt-5-mini", role: "pragmatist", weight: 0.25 },
];

export const DEFAULT_SYNTHESIZER = "gpt-5-mini";

interface PartialCouncilFileConfig {
  members?: unknown;
  synthesizer?: unknown;
  minSurvivors?: unknown;
  perMemberTimeoutMs?: unknown;
  synthTimeoutMs?: unknown;
  maxConcurrency?: unknown;
  probe?: unknown;
}

export interface LoadCouncilConfigOptions {
  cwd?: string;
}

function isValidMember(value: unknown): value is CouncilMemberSpec {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.model === "string" &&
    m.model.length > 0 &&
    typeof m.role === "string" &&
    m.role.length > 0 &&
    typeof m.weight === "number" &&
    Number.isFinite(m.weight) &&
    m.weight > 0
  );
}

/** Read the `council` block from .omp/config.json; tolerate missing/malformed. */
export function readCouncilFileConfig(
  options: LoadCouncilConfigOptions = {},
): PartialCouncilFileConfig {
  const cwd = options.cwd ?? process.cwd();
  const configFile = join(cwd, ".omp", "config.json");
  if (!existsSync(configFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8")) as {
      council?: PartialCouncilFileConfig;
    };
    return parsed.council ?? {};
  } catch {
    return {}; // unreadable/invalid config -> treat as absent
  }
}

/**
 * Resolve the effective council configuration.
 * Precedence: spec override > .omp/config.json council block > built-in default.
 */
export function loadCouncilConfig(
  spec: CouncilTaskSpec = { question: "" },
  options: LoadCouncilConfigOptions = {},
): ResolvedCouncilConfig {
  const file = readCouncilFileConfig(options);

  const fileMembers = Array.isArray(file.members)
    ? file.members.filter(isValidMember)
    : [];

  const members =
    spec.members && spec.members.length > 0
      ? spec.members
      : fileMembers.length > 0
        ? fileMembers
        : DEFAULT_MEMBERS;

  const synthesizerModel =
    spec.synthesizerModel ??
    (typeof file.synthesizer === "string" && file.synthesizer.length > 0
      ? file.synthesizer
      : DEFAULT_SYNTHESIZER);

  const minSurvivors =
    spec.minSurvivors ??
    (typeof file.minSurvivors === "number" ? file.minSurvivors : DEFAULT_MIN_SURVIVORS);

  const perMemberTimeoutMs =
    spec.perMemberTimeoutMs ??
    (typeof file.perMemberTimeoutMs === "number"
      ? file.perMemberTimeoutMs
      : DEFAULT_PER_MEMBER_TIMEOUT_MS);

  const synthTimeoutMs =
    spec.synthTimeoutMs ??
    (typeof file.synthTimeoutMs === "number"
      ? file.synthTimeoutMs
      : perMemberTimeoutMs * 2);

  const maxConcurrency =
    spec.maxConcurrency ??
    (typeof file.maxConcurrency === "number"
      ? file.maxConcurrency
      : DEFAULT_MAX_CONCURRENCY);

  // probe precedence: spec.probe ?? config.probe ?? false
  const probe =
    spec.probe ?? (typeof file.probe === "boolean" ? file.probe : false);

  return {
    members,
    synthesizerModel,
    minSurvivors,
    perMemberTimeoutMs,
    synthTimeoutMs,
    maxConcurrency: maxConcurrency > 0 ? maxConcurrency : DEFAULT_MAX_CONCURRENCY,
    probe,
  };
}
