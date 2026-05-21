#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadCatalogBundle, validateCatalogBundle } from './catalog.js';
import { inspectProject } from './project.js';
import { formatLintIssues, lintSkills } from './lint.js';
import { formatDryRun } from './sync.js';
import {
  applyJiraOperation,
  configSummary,
  discoverJiraConfig,
  fallbackMarkdown,
  readTicketInput,
  renderCreateIssue,
  type JiraOperationName,
} from './jira.js';

async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, subcommand, ...rest] = argv;

  if (command === 'catalog') {
    await handleCatalog(subcommand, rest);
    return;
  }
  if (command === 'project') {
    await handleProject(subcommand, rest);
    return;
  }
  if (command === 'lint:skills' || (command === 'skill' && subcommand === 'lint')) {
    const root = valueAfter(argv, '--root');
    const issues = lintSkills(root ?? {});
    console.log(formatLintIssues(issues));
    process.exitCode = issues.some((issue) => issue.level === 'error') ? 1 : 0;
    return;
  }
  if (command === 'sync:dry-run' || (command === 'skill' && subcommand === 'sync' && argv.includes('--dry-run'))) {
    console.log(formatDryRun());
    return;
  }
  if (command === 'jira:dry-run') {
    const config = discoverJiraConfig({ cwd: process.cwd() });
    console.log(JSON.stringify({ ok: true, dryRun: true, jira: configSummary(config) }, null, 2));
    return;
  }
  if (command === 'jira') {
    await handleJira(subcommand, rest);
    return;
  }

  usage();
}

async function handleCatalog(subcommand: string | undefined, args: string[]): Promise<void> {
  const bundle = loadCatalogBundle();
  if (subcommand === 'validate') {
    const result = validateCatalogBundle(bundle);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (subcommand === 'list' || subcommand === undefined) {
    console.log(JSON.stringify({ capabilities: bundle.capabilities.capabilities.map((item) => item.id), skills: bundle.skills.skills.map((item) => item.name) }, null, 2));
    return;
  }
  usage();
}

async function handleProject(subcommand: string | undefined, args: string[]): Promise<void> {
  if (subcommand === 'inspect') {
    console.log(JSON.stringify(inspectProject({ cwd: valueAfter(args, '--root') ?? process.cwd() }), null, 2));
    return;
  }
  usage();
}

async function handleJira(subcommand: string | undefined, rest: string[]): Promise<void> {
  if (subcommand === 'config') {
    console.log(JSON.stringify(configSummary(discoverJiraConfig()), null, 2));
    return;
  }

  if (subcommand === 'render') {
    const planFile = rest.find((arg) => !arg.startsWith('--'));
    if (!planFile) throw new Error('omc jira render requires a plan file');
    const config = discoverJiraConfig({ cwd: process.cwd() });
    const ticket = readTicketInput(planFile);
    console.log(JSON.stringify(renderCreateIssue(ticket, config), null, 2));
    return;
  }

  if (subcommand === 'apply') {
    const targetOrPlan = rest.find((arg) => !arg.startsWith('--'));
    const operation = parseApplyOperation(rest);
    const dryRun = rest.includes('--dry-run');
    const config = discoverJiraConfig({ cwd: process.cwd() });
    const isFile = Boolean(targetOrPlan && /\.(md|markdown|json)$/i.test(targetOrPlan));
    const ticket = isFile && targetOrPlan ? readTicketInput(targetOrPlan) : undefined;
    const target = isFile ? undefined : targetOrPlan;
    const commentPath = valueAfter(rest, '--comment-file');
    const comment = commentPath ? readFileSync(commentPath, 'utf8') : ticket?.description;
    const transitionState = valueAfter(rest, '--state') ?? valueAfter(rest, '--transition');
    const linkTarget = valueAfter(rest, '--link-target');
    const result = await applyJiraOperation({ operation, target, ticket, comment, update: ticket, transitionState, linkTarget, dryRun }, config);
    if (result.fallback) console.log(fallbackMarkdown(result.fallback));
    else console.log(JSON.stringify(result.response, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (subcommand === '--dry-run' || subcommand === undefined) {
    const config = discoverJiraConfig({ cwd: process.cwd() });
    console.log(JSON.stringify({ ok: true, dryRun: true, jira: configSummary(config) }, null, 2));
    return;
  }

  usage();
}

function parseApplyOperation(args: string[]): JiraOperationName {
  if (args.includes('--comment')) return 'comment';
  if (args.includes('--update')) return 'update';
  if (args.includes('--transition')) return 'transition';
  if (args.includes('--link')) return 'link';
  return 'create';
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): void {
  console.log(`Usage:
  oh-my-copilot catalog validate|list
  oh-my-copilot project inspect [--root <path>]
  oh-my-copilot lint:skills [--root <workspace-root>]
  oh-my-copilot sync:dry-run [--root <workspace-root>]
  oh-my-copilot jira config
  oh-my-copilot jira render <plan-file>
  oh-my-copilot jira apply <ticket-key-or-plan-file> [--comment|--update|--transition <state>|--link --link-target <key>] [--dry-run]
  oh-my-copilot jira:dry-run`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
