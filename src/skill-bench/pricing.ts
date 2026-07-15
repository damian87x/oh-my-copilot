import type {
  PublicModelTokenRates,
  PublicPricingSnapshot,
} from "./telemetry.js";

export const GITHUB_COPILOT_PRICING_PAGE_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
export const GITHUB_COPILOT_PRICING_API_URL =
  "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing";

export interface GitHubCopilotPricingSnapshot extends PublicPricingSnapshot {
  source: "public-github-copilot-model-pricing";
  apiUrl: string;
  completeness: "unambiguous-model-rates";
  unresolvedTieredModels: string[];
}

type SkillBenchPricingResolver =
  () => Promise<GitHubCopilotPricingSnapshot | null>;

let testPricingResolver: SkillBenchPricingResolver | null = null;

export function setSkillBenchPricingResolverForTests(
  resolver: SkillBenchPricingResolver | null,
): void {
  testPricingResolver = resolver;
}

export async function resolveGitHubCopilotPricing(): Promise<GitHubCopilotPricingSnapshot | null> {
  if (testPricingResolver) return testPricingResolver();
  try {
    const response = await fetch(GITHUB_COPILOT_PRICING_API_URL, {
      headers: { accept: "text/markdown" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return parseGitHubCopilotPricingMarkdown(
      await response.text(),
      new Date().toISOString(),
    );
  } catch {
    return null;
  }
}

export function parseGitHubCopilotPricingMarkdown(
  markdown: string,
  retrievedAt: string,
): GitHubCopilotPricingSnapshot {
  const rows = new Map<string, PublicModelTokenRates[]>();
  let headers: string[] | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      headers = null;
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells[0]?.toLowerCase() === "model") {
      headers = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (
      !headers ||
      cells.length !== headers.length ||
      cells.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }
    const row = Object.fromEntries(
      headers.map((header, index) => [header, cells[index] ?? ""]),
    );
    const modelId = pricingModelSlug(row.model ?? "");
    if (!modelId) continue;
    const inputUsdPerMillion = price(row.input);
    const outputUsdPerMillion = price(row.output);
    if (inputUsdPerMillion === null || outputUsdPerMillion === null) continue;
    const rates: PublicModelTokenRates = {
      inputUsdPerMillion,
      outputUsdPerMillion,
    };
    const cacheReadUsdPerMillion = price(row["cached input"]);
    const cacheWriteUsdPerMillion = price(row["cache write"]);
    if (cacheReadUsdPerMillion !== null)
      rates.cacheReadUsdPerMillion = cacheReadUsdPerMillion;
    if (cacheWriteUsdPerMillion !== null)
      rates.cacheWriteUsdPerMillion = cacheWriteUsdPerMillion;
    const modelRows = rows.get(modelId) ?? [];
    modelRows.push(rates);
    rows.set(modelId, modelRows);
  }

  const models: Record<string, PublicModelTokenRates> = {};
  const unresolvedTieredModels: string[] = [];
  for (const [modelId, modelRows] of [...rows.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (modelRows.length === 1) models[modelId] = modelRows[0];
    else unresolvedTieredModels.push(modelId);
  }
  if (Object.keys(models).length === 0) {
    throw new Error("GitHub Copilot pricing page contained no unambiguous model rates");
  }
  return {
    source: "public-github-copilot-model-pricing",
    url: GITHUB_COPILOT_PRICING_PAGE_URL,
    apiUrl: GITHUB_COPILOT_PRICING_API_URL,
    retrievedAt,
    currency: "USD",
    completeness: "unambiguous-model-rates",
    models,
    unresolvedTieredModels,
  };
}

function pricingModelSlug(displayName: string): string {
  return displayName
    .replaceAll(/\[\^[^\]]+\]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function price(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim().replace(/^\$/, "").replaceAll(",", ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
