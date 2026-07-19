import {
  analyzeHistory,
  parseHistoryWindow,
  type HistoryProjectScope,
  type HistoryWindow,
} from "../history/analyze.js";
import { formatHistoryMarkdown } from "../history/format-report.js";
import {
  parseHistoryReportView,
  type HistoryReportView,
} from "../history/report-view.js";
import { resolveGitHubCopilotPricing } from "../skill-bench/pricing.js";
import { resolveHtmlPath, writeHistoryHtmlReport } from "./history.js";
import type { CliResult, CommandModule } from "./types.js";

const PROJECTS = ["current", "all"] as const;

/**
 * Bulletproof skill-retro entrypoint for weak models.
 * Defaults: 14d, project=all, view=simple, price=none, markdown tables.
 * Never requires JSON parsing by the agent.
 */
export function parseSkillRetroArgs(argv: string[]): {
  window: HistoryWindow;
  project: HistoryProjectScope;
  price: "none" | "public";
  view: HistoryReportView;
  htmlPath: string | null;
  htmlDefault: boolean;
} {
  const args = argv[0] === "skill-retro" ? argv.slice(1) : argv;
  let window: HistoryWindow = "14d";
  let project: HistoryProjectScope = "all";
  let price: "none" | "public" = "none";
  let view: HistoryReportView = "simple";
  let htmlPath: string | null = null;
  let htmlDefault = false;
  const seen = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") continue;
    if (flag === "--help" || flag === "-h") {
      throw new Error(
        "usage: omp skill-retro [simple|advanced] [7d|14d|30d|Nd|all] [current|all] [--view simple|advanced] [--days N] [--window W] [--project SCOPE] [--price public|none] [--html [path]]",
      );
    }
    if (flag === "--view" || flag === "--mode") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires simple or advanced`);
      }
      view = parseHistoryReportView(value);
      continue;
    }
    if (flag === "simple" || flag === "advanced") {
      view = flag;
      continue;
    }
    if (flag === "--price") {
      const value = args[++i];
      if (value !== "public" && value !== "none") {
        throw new Error("--price accepts: public, none");
      }
      price = value;
      continue;
    }
    if (flag === "--days") {
      const value = args[++i];
      if (!value || !/^[1-9]\d*$/.test(value)) {
        throw new Error("--days requires integer 1..365");
      }
      window = parseHistoryWindow(`${value}d`);
      continue;
    }
    if (flag === "--window" || flag === "--since") {
      const value = args[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      window = parseHistoryWindow(value);
      continue;
    }
    if (flag === "--project") {
      const value = args[++i];
      if (value !== "current" && value !== "all") {
        throw new Error("--project accepts: current, all");
      }
      project = value;
      continue;
    }
    if (flag === "--html") {
      if (seen.has("--html")) throw new Error("conflicting --html");
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
    if (PROJECTS.includes(flag as HistoryProjectScope)) {
      project = flag as HistoryProjectScope;
      continue;
    }
    if (flag === "all" || /^[1-9]\d*d$/.test(flag)) {
      window = parseHistoryWindow(flag);
      continue;
    }
    throw new Error(`unexpected skill-retro argument: ${flag}`);
  }

  return { window, project, price, view, htmlPath, htmlDefault };
}

/** Plain-language choices for the human — not CLI flags. */
export function formatFriendlyNextSteps(
  view: HistoryReportView,
  htmlPath: string | null,
): string {
  const lines = ["### What next?", "", "Just reply in plain words:"];
  if (view === "simple") {
    lines.push(
      "",
      "1. **More detail** — show the full report (shared sessions, warnings, full token breakdown)",
      "2. **Show dollar estimates** — fill in public pricing for the by-model table",
      "3. **Save as HTML** — write a file you can open in a browser",
      "4. **Done** — nothing else needed",
    );
  } else {
    lines.push(
      "",
      "1. **Simpler view** — only top skills, times used, and tokens",
      "2. **Show dollar estimates** — fill in public pricing for the by-model table",
      "3. **Save as HTML** — write a file you can open in a browser",
      "4. **Done** — nothing else needed",
    );
  }
  if (htmlPath) {
    // HTML already written — do not open yet; force an explicit yes/no.
    lines.length = 0;
    lines.push(
      "### HTML report ready",
      "",
      `Saved to: \`${htmlPath}\``,
      "",
      "**Open this report in your browser now?**",
      "",
      "Reply **yes** to open, or **no** to skip.",
      "",
      "_(Do not open until the user answers.)_",
    );
  }
  return lines.join("\n");
}

export const skillRetroCommand: CommandModule = {
  name: "skill-retro",
  aliases: ["retro"],
  summary:
    "skill-retro [simple|advanced] [7d|14d|30d|Nd|all] [current|all] [--view] [--days N] [--price public|none] [--html [path]]  (default: simple 14d markdown tables)",
  async run(argv, context): Promise<CliResult> {
    try {
      const args = parseSkillRetroArgs(argv);
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
        // Still discouraged for agents; available for scripts.
        return {
          ok: true,
          output: {
            reportFormat: "skill-retro-v1",
            view: args.view,
            ...report,
            ...(htmlOut ? { htmlReportPath: htmlOut } : {}),
            markdown: formatHistoryMarkdown(report, args.view),
          },
        };
      }

      const markdown = formatHistoryMarkdown(report, args.view);
      const nextSteps = formatFriendlyNextSteps(args.view, htmlOut);
      // User-facing only: tables + plain-language next steps (no flag soup).
      return {
        ok: true,
        message: `${markdown}\n\n${nextSteps}`,
      };
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

