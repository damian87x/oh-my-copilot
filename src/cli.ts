#!/usr/bin/env node
import { findCapability, loadCatalogBundle, validateCatalogBundle } from "./catalog.js";
import { inspectProject } from "./project.js";

interface CliResult {
  ok: boolean;
  exitCode?: number;
  output?: unknown;
  message?: string;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printResult(result: CliResult, json: boolean): void {
  if (json || typeof result.output === "object") {
    console.log(JSON.stringify(result.output ?? { ok: result.ok, message: result.message }, null, 2));
    return;
  }
  if (result.message) {
    console.log(result.message);
  }
}

function help(): string {
  return `oh-my-copilot\n\nCommands:\n  catalog list [--json]\n  catalog validate [--json]\n  catalog capability <id> [--json]\n  project inspect [--json]\n  lint:skills [--root <workspace>]\n  sync:dry-run [--root <workspace>]\n  jira:dry-run [--root <workspace>]\n  jira render <plan-file> [--root <workspace>] [--json]\n  jira apply <ticket-key-or-plan-file> --comment|--update|--transition|--link [--dry-run] [--json]\n`;
}

async function resolveExistingInputPath(value: string): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { isAbsolute, resolve } = await import("node:path");
  const direct = isAbsolute(value) ? value : resolve(process.cwd(), value);
  if (existsSync(direct)) return direct;
  const parentRelative = isAbsolute(value) ? value : resolve(process.cwd(), "..", value);
  if (existsSync(parentRelative)) return parentRelative;
  return direct;
}

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  const [group, command, value] = argv;
  const json = hasFlag(argv, "--json");

  if (!group || group === "help" || group === "--help" || group === "-h") {
    return { ok: true, message: help() };
  }

  if (group === "catalog") {
    if (command === "list") {
      const bundle = loadCatalogBundle();
      const output = bundle.capabilities.capabilities
        .filter((capability) => capability.phase1)
        .map((capability) => ({
          id: capability.id,
          command: `/${capability.defaultCommand}`,
          category: capability.category,
          phase1: capability.phase1,
          copilot: capability.providerSupport.copilot.state,
        }));
      return json ? { ok: true, output } : { ok: true, message: output.map((item) => `${item.id}\t${item.command}\t${item.copilot}`).join("\n") };
    }

    if (command === "validate") {
      const result = validateCatalogBundle();
      return {
        ok: result.ok,
        exitCode: result.ok ? 0 : 1,
        output: json ? result : undefined,
        message: result.ok ? "Catalog validation PASS" : `Catalog validation FAIL (${result.issues.length} issue(s))`,
      };
    }

    if (command === "capability" && value) {
      const capability = findCapability(value);
      if (!capability) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: `Unknown capability: ${value}` } : undefined, message: `Unknown capability: ${value}` };
      }
      return json ? { ok: true, output: capability } : { ok: true, message: `${capability.id}: ${capability.summary}` };
    }
  }

  if (group === "project" && command === "inspect") {
    const output = inspectProject();
    return json ? { ok: true, output } : { ok: true, message: `packageRoot=${output.packageRoot}\nskillsRoot=${output.defaultSkillsRoot}\nhasCatalog=${output.hasCatalog}` };
  }

  if (group === "lint:skills") {
    const { lintSkills, formatLintIssues } = await import("./lint.js");
    const issues = lintSkills(flagValue(argv, "--root"));
    const ok = issues.filter((issue) => issue.level === "error").length === 0;
    return { ok, exitCode: ok ? 0 : 1, message: formatLintIssues(issues) };
  }

  if (group === "sync:dry-run") {
    const { formatDryRun } = await import("./sync.js");
    return { ok: true, message: formatDryRun() };
  }

  if (group === "jira:dry-run") {
    const jira = await import("./jira.js") as unknown as Record<string, any>;
    if (typeof jira.formatJiraDryRun === "function") {
      return { ok: true, message: jira.formatJiraDryRun() as string };
    }
    const config = typeof jira.discoverJiraConfig === "function" ? jira.discoverJiraConfig({ root: flagValue(argv, "--root") ?? ".." }) : undefined;
    const payloads = [
      typeof jira.createIssuePayload === "function" ? jira.createIssuePayload(config, { summary: "Phase 1 MVP tracking ticket", description: "Prepared by oh-my-copilot dry-run adapter." }) : undefined,
      typeof jira.commentPayload === "function" ? jira.commentPayload(config, "<ISSUE-KEY>", "Verification evidence goes here.") : undefined,
      typeof jira.safeUpdatePayload === "function" ? jira.safeUpdatePayload(config, "<ISSUE-KEY>", { labels: ["oh-my-copilot"] }) : undefined,
    ].filter(Boolean);
    return { ok: true, message: `PASS: Jira dry-run fallback payloads\n${JSON.stringify(payloads, null, 2)}` };
  }

  if (group === "jira") {
    const jira = await import("./jira.js");
    const root = flagValue(argv, "--root") ?? process.cwd();
    const config = jira.discoverJiraConfig({ cwd: root });

    if (command === "render" && value) {
      const inputPath = await resolveExistingInputPath(value);
      const ticket = jira.readTicketInput(inputPath);
      const output = {
        ok: true,
        dryRun: true,
        source: inputPath,
        jira: jira.configSummary(config),
        operations: {
          create: jira.createIssuePayload(config, ticket),
          comment: jira.commentPayload(config, "<ISSUE-KEY>", `Planning source: ${inputPath}\n\n${ticket.summary}`),
          update: jira.safeUpdatePayload(config, "<ISSUE-KEY>", ticket),
          transition: jira.transitionFallbackPayload(config, "<ISSUE-KEY>", "planned"),
          link: jira.linkFallbackPayload(config, "<ISSUE-KEY>", "<RELATED-ISSUE-KEY>"),
        },
      };
      return json ? { ok: true, output } : { ok: true, message: JSON.stringify(output, null, 2) };
    }

    if (command === "apply" && value) {
      const operation = hasFlag(argv, "--comment")
        ? "comment"
        : hasFlag(argv, "--update")
          ? "update"
          : hasFlag(argv, "--transition")
            ? "transition"
            : hasFlag(argv, "--link")
              ? "link"
              : "create";
      const isFileInput = /\.[a-z0-9]+$/i.test(value);
      const inputPath = isFileInput ? await resolveExistingInputPath(value) : undefined;
      const ticket = inputPath ? jira.readTicketInput(inputPath) : undefined;
      const result = await jira.applyJiraOperation({
        operation,
        target: inputPath ? undefined : value,
        ticket,
        comment: ticket ? ticket.summary : "Verification evidence goes here.",
        update: ticket,
        transitionState: flagValue(argv, "--state") ?? "done",
        linkTarget: flagValue(argv, "--link-target"),
        dryRun: hasFlag(argv, "--dry-run") || config.mode !== "live",
      }, config);
      return json ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result } : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result, null, 2) };
    }
  }

  return { ok: false, exitCode: 1, message: `Unknown command.\n\n${help()}` };
}

const result = await runCli();
printResult(result, process.argv.includes("--json"));
process.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
