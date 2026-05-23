#!/usr/bin/env node
import { pathToFileURL } from "node:url";
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
  return `oh-my-copilot\n\nCommands:\n  version [--json]\n  list [--json]\n  setup [--dry-run] [--scope project|user] [--plugin-root <dir>] [--json]\n  doctor [--json] [--copilot-bin <path>] [--skip-copilot]\n  launch -- <args...>\n  team <N:role> "<task>" [--name <name>] [--json]\n  team status <name> [--json]\n  team shutdown <name> [--json]\n  team api claim-task --input '<json>' [--json]\n  team api transition-task-status --input '<json>' [--json]\n  catalog list [--json]\n  catalog validate [--json]\n  catalog capability <id> [--json]\n  project inspect [--json]\n  skill install <skill-dir> [--root <repo>] [--scope project|user] [--dry-run] [--json]\n  lint:skills [--root <repo>]\n  sync:dry-run [--root <repo>]\n  jira:dry-run [--root <repo>]\n  jira render <plan-file> [--root <repo>] [--json]\n  jira apply <ticket-key-or-plan-file> --comment|--update|--transition|--link [--dry-run] [--json]\n`;
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

  if (group === "version" || group === "--version" || group === "-v") {
    const { getVersionInfo, formatVersionInfo } = await import("./copilot/version.js");
    const info = getVersionInfo({ importMetaUrl: import.meta.url });
    return json ? { ok: true, output: info } : { ok: true, message: formatVersionInfo(info) };
  }

  if (group === "list") {
    const { listAll, formatList } = await import("./copilot/list.js");
    const list = await listAll({ cwd: flagValue(argv, "--root") ?? process.cwd() });
    return json ? { ok: true, output: list } : { ok: true, message: formatList(list) };
  }

  if (group === "setup") {
    const { runSetup, formatSetup } = await import("./copilot/setup.js");
    const result = runSetup({
      cwd: flagValue(argv, "--root") ?? process.cwd(),
      pluginRoot: flagValue(argv, "--plugin-root"),
      importMetaUrl: import.meta.url,
      dryRun: hasFlag(argv, "--dry-run"),
      scope: flagValue(argv, "--scope") === "user" ? "user" : "project",
    });
    return json ? { ok: result.ok, output: result } : { ok: result.ok, message: formatSetup(result) };
  }

  if (group === "doctor") {
    const { runDoctor, formatDoctor } = await import("./copilot/doctor.js");
    const report = runDoctor({
      cwd: flagValue(argv, "--root") ?? process.cwd(),
      pluginRoot: flagValue(argv, "--plugin-root"),
      importMetaUrl: import.meta.url,
      copilotBin: flagValue(argv, "--copilot-bin"),
      skipCopilot: hasFlag(argv, "--skip-copilot"),
    });
    return json
      ? { ok: report.ok, exitCode: report.ok ? 0 : 1, output: report }
      : { ok: report.ok, exitCode: report.ok ? 0 : 1, message: formatDoctor(report) };
  }

  if (group === "launch") {
    const dashIndex = argv.indexOf("--");
    const passthrough = dashIndex >= 0 ? argv.slice(dashIndex + 1) : argv.slice(1);
    const { launchCopilot } = await import("./copilot/launch.js");
    const result = await launchCopilot({
      args: passthrough,
      bin: flagValue(argv, "--bin"),
      cwd: flagValue(argv, "--root") ?? process.cwd(),
    });
    return json
      ? { ok: result.ok, exitCode: result.exitCode, output: result }
      : {
          ok: result.ok,
          exitCode: result.exitCode,
          message: `launch ${result.bin} exit=${result.exitCode}`,
        };
  }

  if (group === "team") {
    return await handleTeamCommand(argv, json);
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

  if (group === "skill" && command === "install" && value) {
    const { installSkill, formatSkillInstall } = await import("./skills.js");
    try {
      const result = installSkill({
        cwd: process.cwd(),
        root: flagValue(argv, "--root"),
        source: value,
        scope: flagValue(argv, "--scope") === "user" ? "user" : "project",
        dryRun: hasFlag(argv, "--dry-run"),
      });
      return json ? { ok: true, output: result } : { ok: true, message: formatSkillInstall(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, output: json ? { ok: false, error: message } : undefined, message };
    }
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
    const config = typeof jira.discoverJiraConfig === "function" ? jira.discoverJiraConfig({ cwd: flagValue(argv, "--root") ?? process.cwd() }) : undefined;
    if (typeof jira.formatJiraDryRun === "function") {
      return { ok: true, message: jira.formatJiraDryRun(config) as string };
    }
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
      if (operation === "link" && !flagValue(argv, "--link-target")) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: "jira apply --link requires --link-target <issue-key>" } : undefined, message: "jira apply --link requires --link-target <issue-key>" };
      }
      if (operation === "create" && !ticket) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: "jira apply create requires a readable plan/ticket file" } : undefined, message: "jira apply create requires a readable plan/ticket file" };
      }
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

const TEAM_SPEC_RE = /^(\d+):([\w-]+)$/;

async function handleTeamCommand(argv: string[], json: boolean): Promise<CliResult> {
  const [, command, value, extra] = argv;
  const cwd = flagValue(argv, "--root") ?? process.cwd();

  if (command && TEAM_SPEC_RE.test(command)) {
    const match = command.match(TEAM_SPEC_RE)!;
    const workerCount = Number(match[1]);
    const role = match[2]!;
    if (!value) {
      return { ok: false, exitCode: 1, message: "team <N:role> requires a task description" };
    }
    const name = flagValue(argv, "--name") ?? `${role}-${Date.now().toString(36)}`;
    const { startTeam } = await import("./team/runtime.js");
    try {
      const result = await startTeam({ cwd, name, role, workerCount, task: value });
      return json
        ? { ok: true, output: result }
        : {
            ok: true,
            message: `started team ${name} session=${result.tmuxSession} workers=${result.config.workers
              .map((w) => `${w.name}(${w.paneId ?? "?"})`)
              .join(",")}`,
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, output: json ? { ok: false, error: message } : undefined, message };
    }
  }

  if (command === "status" && value) {
    const { statusTeam, formatStatus } = await import("./team/runtime.js");
    const report = statusTeam({ cwd, name: value });
    return json
      ? { ok: report.ok, output: report }
      : { ok: report.ok, message: formatStatus(report) };
  }

  if (command === "shutdown" && value) {
    const { shutdownTeam } = await import("./team/runtime.js");
    const result = await shutdownTeam({ cwd, name: value });
    return json
      ? { ok: result.ok, output: result }
      : {
          ok: result.ok,
          message: `shutdown team ${value} killedPanes=${result.killedPanes} killedSession=${result.killedSession}`,
        };
  }

  if (command === "api") {
    const sub = value;
    const inputRaw = flagValue(argv, "--input");
    if (!sub || !inputRaw) {
      return { ok: false, exitCode: 1, message: "team api <sub> --input '<json>' required" };
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(inputRaw) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, message: `invalid --input JSON: ${message}` };
    }
    const api = await import("./team/api.js");
    if (sub === "claim-task") {
      const result = api.apiClaimTask(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "transition-task-status") {
      const result = api.apiTransitionTaskStatus(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    return { ok: false, exitCode: 1, message: `Unknown team api command: ${sub}` };
  }

  // tolerate trailing extras (e.g., '--json')
  void extra;
  return { ok: false, exitCode: 1, message: `Unknown team command. Try: omc team <N:role> "<task>" | status <name> | shutdown <name> | api <sub>` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();
  printResult(result, process.argv.includes("--json"));
  process.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
}
