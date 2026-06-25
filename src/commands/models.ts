import { DEFAULT_MEMBERS } from "../council/config.js";
import type { CouncilSpawn } from "../council/types.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  KNOWN_MODEL_SLUGS,
  probeModels,
  type ProbeModelsOptions,
  type ProbeStatus,
} from "../copilot/models.js";
import { readMemoryConfig } from "../memory-review/config.js";
import { createReviewSpawn } from "../memory-review/spawn.js";
import type { CliContext, CliResult, CommandModule } from "./types.js";

// `omp models` — there's no headless list-models in copilot, so we PROBE a
// candidate set (curated + your configured model + council defaults + any
// --candidates) and report what actually runs. Probing reflects BYOK too.

export type ModelSource = "config" | "candidate" | "built-in";
export interface ModelReportRow {
  slug: string;
  status: ProbeStatus;
  source: ModelSource;
}

/** Candidate slugs with a source tag. config/candidate win over built-in. */
export function buildCandidates(opts: { configured?: string; candidates?: string[] }): Map<string, ModelSource> {
  const map = new Map<string, ModelSource>();
  for (const m of KNOWN_MODEL_SLUGS) if (!map.has(m)) map.set(m, "built-in");
  for (const m of DEFAULT_MEMBERS.map((d) => d.model)) if (!map.has(m)) map.set(m, "built-in");
  if (opts.configured) map.set(opts.configured, "config");
  for (const m of opts.candidates ?? []) map.set(m, "candidate");
  return map;
}

const STATUS_ORDER: Record<ProbeStatus, number> = { available: 0, unavailable: 1, unknown: 2 };
const STATUS_MARK: Record<ProbeStatus, string> = { available: "✓", unavailable: "✗", unknown: "?" };
const STATUS_NOTE: Record<ProbeStatus, string> = {
  available: "",
  unavailable: " — not available on your plan",
  unknown: " — probe failed/unverified",
};

/** Probe every candidate and return rows sorted available → unavailable → unknown. */
export async function collectModelReport(
  spawn: CouncilSpawn,
  sources: Map<string, ModelSource>,
  opts: { timeoutMs?: number; onProbe?: ProbeModelsOptions["onProbe"] } = {},
): Promise<ModelReportRow[]> {
  const probed = await probeModels(spawn, [...sources.keys()], {
    timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    onProbe: opts.onProbe,
  });
  const rows: ModelReportRow[] = probed.map((r) => ({
    slug: r.model,
    status: r.status,
    source: sources.get(r.model) ?? "built-in",
  }));
  rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.slug.localeCompare(b.slug));
  return rows;
}

export function formatModelReport(rows: ModelReportRow[]): string {
  const body = rows
    .map((r) => `  ${STATUS_MARK[r.status]} ${r.slug} (${r.source})${STATUS_NOTE[r.status]}`)
    .join("\n");
  return `Model availability (probed; ✓ usable, ✗ not on your plan, ? unverified):\n${body}`;
}

function parseCandidates(argv: string[]): string[] {
  const i = argv.indexOf("--candidates");
  if (i === -1 || i + 1 >= argv.length) return [];
  return argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
}

export const modelsCommand: CommandModule = {
  name: "models",
  summary: "probe which Copilot models are available: models [--candidates a,b,c] [--json]",
  async run(argv: string[], context: CliContext): Promise<CliResult> {
    const homeDir = process.env.OMP_HOME_OVERRIDE || undefined;
    const configured = readMemoryConfig(context.cwd, { homeDir }).memoryReviewModel;
    const sources = buildCandidates({ configured, candidates: parseCandidates(argv) });
    // Probing is slow (copilot's headless -p ~12s each), so show live progress on
    // stderr when attached to a terminal — never on stdout (keeps --json/report clean).
    const showProgress = process.stderr.isTTY && !context.json;
    if (showProgress) {
      const secs = Math.round(DEFAULT_PROBE_TIMEOUT_MS / 1000);
      process.stderr.write(`Probing ${sources.size} model(s) — up to ~${secs}s each (copilot's headless mode is slow)…\n`);
    }
    const rows = await collectModelReport(createReviewSpawn(), sources, {
      onProbe: showProgress
        ? (r, done, total) => {
            const mark = r.status === "available" ? "✓" : r.status === "unavailable" ? "✗" : "?";
            process.stderr.write(`  [${done}/${total}] ${mark} ${r.model}\n`);
          }
        : undefined,
    });
    return context.json
      ? { ok: true, output: { models: rows } }
      : { ok: true, message: formatModelReport(rows) };
  },
};
