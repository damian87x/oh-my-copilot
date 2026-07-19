import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  analyzeHistory,
  parseHistoryWindow,
  type HistoryAnalysis,
  type HistoryProjectScope,
  type HistoryWindow,
} from "../history/analyze.js";
import { formatHistoryHtml } from "../history/format-html.js";
import { formatHistoryMarkdown } from "../history/format-report.js";
import {
  parseHistoryReportView,
  type HistoryReportView,
} from "../history/report-view.js";
import { resolveGitHubCopilotPricing } from "../skill-bench/pricing.js";
import type { CliResult, CommandModule } from "./types.js";

const PROJECTS = ["current", "all"] as const;

export function parseHistoryArgs(argv: string[]): {
  window: HistoryWindow;
  project: HistoryProjectScope;
  price: "none" | "public";
  view: HistoryReportView;
  htmlPath: string | null;
  htmlDefault: boolean;
} {
  const args = argv[0] === "history" ? argv.slice(1) : argv;
  if (args[0] !== "analyze") throw new Error("history supports only: analyze");
  let window: HistoryWindow = "30d";
  let project: HistoryProjectScope = "all";
  let price: "none" | "public" = "none";
  let view: HistoryReportView = "simple";
  let htmlPath: string | null = null;
  let htmlDefault = false;
  const seen = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") continue;
    if (flag === "--view" || flag === "--mode") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value; accepted: simple, advanced`);
      }
      const normalized = parseHistoryReportView(value);
      if (seen.has("--view") && seen.get("--view") !== normalized) {
        throw new Error("conflicting --view values");
      }
      seen.set("--view", normalized);
      view = normalized;
      continue;
    }
    if (flag === "simple" || flag === "advanced") {
      if (seen.has("--view") && seen.get("--view") !== flag) {
        throw new Error("conflicting --view values");
      }
      seen.set("--view", flag);
      view = flag;
      continue;
    }
    if (flag === "--html") {
      if (seen.has("--html")) throw new Error("conflicting --html values");
      const next = args[i + 1];
      if (
        next &&
        !next.startsWith("--") &&
        next !== "all" &&
        next !== "current" &&
        next !== "simple" &&
        next !== "advanced" &&
        !/^[1-9]\d*d$/.test(next)
      ) {
        htmlPath = next;
        seen.set("--html", next);
        i++;
      } else {
        htmlDefault = true;
        seen.set("--html", ":default:");
      }
      continue;
    }
    if (flag === "--price") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--price requires a value; accepted: public, none");
      }
      if (value !== "public" && value !== "none") {
        throw new Error("--price accepts: public, none");
      }
      if (seen.has("--price") && seen.get("--price") !== value) {
        throw new Error("conflicting --price values");
      }
      seen.set("--price", value);
      price = value;
      continue;
    }
    if (flag === "--days") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--days requires an integer 1..365");
      }
      if (!/^[1-9]\d*$/.test(value)) {
        throw new Error("--days requires an integer 1..365");
      }
      const normalized = parseHistoryWindow(`${value}d`);
      if (seen.has("--window") && seen.get("--window") !== normalized) {
        throw new Error("conflicting --window values");
      }
      seen.set("--window", normalized);
      window = normalized;
      continue;
    }
    const hasExplicitScope = seen.has("--window") || seen.has("--project");
    const looksLikeWindow = flag === "all" || /^[1-9]\d*d$/.test(flag);
    const isPositionalWindow = looksLikeWindow && !(flag === "all" && hasExplicitScope);
    if (isPositionalWindow) {
      const normalized = parseHistoryWindow(flag);
      if (seen.has("--window") && seen.get("--window") !== normalized) {
        throw new Error("conflicting --window values");
      }
      seen.set("--window", normalized);
      window = normalized;
      continue;
    }
    if (PROJECTS.includes(flag as HistoryProjectScope)) {
      if (seen.has("--project") && seen.get("--project") !== flag) {
        throw new Error("conflicting --project values");
      }
      seen.set("--project", flag);
      project = flag as HistoryProjectScope;
      continue;
    }
    if (flag !== "--window" && flag !== "--since" && flag !== "--project") {
      throw new Error(`unexpected history argument: ${flag}`);
    }
    const value = args[++i];
    const canonical = flag === "--since" ? "--window" : flag;
    if (!value || value.startsWith("--")) {
      const accepted =
        canonical === "--window"
          ? "7d, 30d, 90d, all, or Nd (1..365 days)"
          : PROJECTS.join(", ");
      throw new Error(`${flag} requires a value; accepted: ${accepted}`);
    }
    if (canonical === "--window") {
      const normalized = parseHistoryWindow(value);
      if (seen.has(canonical) && seen.get(canonical) !== normalized) {
        throw new Error(`conflicting ${canonical} values`);
      }
      seen.set(canonical, normalized);
      window = normalized;
    } else {
      if (seen.has(canonical) && seen.get(canonical) !== value) {
        throw new Error(`conflicting ${canonical} values`);
      }
      seen.set(canonical, value);
      if (!PROJECTS.includes(value as HistoryProjectScope)) {
        throw new Error(`--project accepts: ${PROJECTS.join(", ")}`);
      }
      project = value as HistoryProjectScope;
    }
  }
  return { window, project, price, view, htmlPath, htmlDefault };
}

export function defaultHtmlReportPath(cwd: string, window: HistoryWindow, now = new Date()): string {
  const stamp = now.toISOString().replaceAll(":", "").replaceAll(".", "").slice(0, 15);
  return join(cwd, ".omp", "reports", `skill-retro-${window}-${stamp}.html`);
}

export function resolveHtmlPath(
  cwd: string,
  window: HistoryWindow,
  htmlPath: string | null,
  htmlDefault: boolean,
  now = new Date(),
): string | null {
  if (!htmlDefault && htmlPath === null) return null;
  if (htmlPath) return isAbsolute(htmlPath) ? htmlPath : resolve(cwd, htmlPath);
  return defaultHtmlReportPath(cwd, window, now);
}

export function writeHistoryHtmlReport(
  path: string,
  report: HistoryAnalysis,
  view: HistoryReportView = "simple",
): string {
  const html = formatHistoryHtml(report, view);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, "utf8");
  return path;
}

export function formatHistory(
  report: HistoryAnalysis,
  view: HistoryReportView = "simple",
): string {
  return formatHistoryMarkdown(report, view);
}

export const historyCommand: CommandModule = {
  name: "history",
  summary:
    "history analyze [7d|30d|90d|Nd|all] [current|all] [simple|advanced] [--view simple|advanced] [--window/--since WINDOW] [--days N] [--project SCOPE] [--price public|none] [--html [path]] [--json]",
  async run(argv, context): Promise<CliResult> {
    try {
      const args = parseHistoryArgs(argv);
      const publicPricing =
        args.price === "public" ? await resolveGitHubCopilotPricing() : null;
      const report = analyzeHistory({
        window: args.window,
        project: args.project,
        cwd: context.cwd,
        publicPricing,
      });
      const htmlOut = resolveHtmlPath(
        context.cwd,
        args.window,
        args.htmlPath,
        args.htmlDefault,
      );
      if (htmlOut) writeHistoryHtmlReport(htmlOut, report, args.view);

      if (context.json) {
        return {
          ok: true,
          output: {
            ...report,
            view: args.view,
            ...(htmlOut ? { htmlReportPath: htmlOut } : {}),
          },
        };
      }
      const markdown = formatHistory(report, args.view);
      const message = htmlOut
        ? `${markdown}\n\n---\nHTML report written: ${htmlOut}`
        : markdown;
      return { ok: true, message };
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
