import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";

export interface SetupOptions extends ResolveCopilotPathsOptions {
  dryRun?: boolean;
  scope?: "project" | "user";
}

export type SetupActionKind = "copy" | "create" | "skip-exists" | "skip-source-missing";

export interface SetupAction {
  source: string;
  target: string;
  kind: SetupActionKind;
}

export interface SetupResult {
  ok: boolean;
  dryRun: boolean;
  scope: "project" | "user";
  actions: SetupAction[];
  paths: CopilotPaths;
}

const COPILOT_INSTRUCTIONS_TEMPLATE = `# oh-my-copilot

Default behaviours installed by \`omp setup\`. Override per project as needed.

## Approach
- Surface assumptions before coding.
- Prefer the simplest change that satisfies the request.
- Touch only what the task requires.
- Verify success with concrete checks: tests, output, behaviour.

## Validation
- Run tests for code you change.
- Read the diff before committing.
- If unsure about scope, ask.

## Cost/token discipline
Cost data is local, best-effort, and estimated. \`omp cost [--today] [--session <id>]\`
summarizes prompt/tool token estimates from the hook ledger; it is not provider billing.

The cost hooks apply when this plugin's \`hooks/hooks.json\` is active in a Copilot CLI
session. They give session-wide visibility for skills invoked inside that session, not
standalone coverage for copied skills, raw shell scripts, or external CLIs.

Before rerunning noisy commands or failed edits, inspect the latest output and narrow the
next attempt. Prefer bounded summaries for large logs. Oversized postToolUse output is
minimized before it re-enters model context, with raw output preserved on disk and savings
recorded in the cost ledger. Budget gates and retry-cost guidance are not current live behavior.
`;

function copyDirRecursive(source: string, target: string, actions: SetupAction[], dryRun: boolean): void {
  if (!existsSync(source)) {
    actions.push({ source, target, kind: "skip-source-missing" });
    return;
  }
  if (!dryRun && !existsSync(target)) mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sPath = join(source, entry.name);
    const tPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sPath, tPath, actions, dryRun);
    } else if (entry.isFile()) {
      if (existsSync(tPath)) {
        actions.push({ source: sPath, target: tPath, kind: "skip-exists" });
        continue;
      }
      if (!dryRun) {
        mkdirSync(dirname(tPath), { recursive: true });
        copyFileSync(sPath, tPath);
      }
      actions.push({ source: sPath, target: tPath, kind: "copy" });
    }
  }
}

function ensureFile(target: string, content: string, actions: SetupAction[], dryRun: boolean): void {
  if (existsSync(target)) {
    actions.push({ source: "(template)", target, kind: "skip-exists" });
    return;
  }
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  actions.push({ source: "(template)", target, kind: "create" });
}

function ensureDir(target: string, actions: SetupAction[], dryRun: boolean): void {
  if (existsSync(target)) {
    actions.push({ source: "(dir)", target, kind: "skip-exists" });
    return;
  }
  if (!dryRun) mkdirSync(target, { recursive: true });
  actions.push({ source: "(dir)", target, kind: "create" });
}

export function runSetup(options: SetupOptions = {}): SetupResult {
  const paths = resolveCopilotPaths(options);
  const dryRun = Boolean(options.dryRun);
  const scope = options.scope ?? "project";
  const actions: SetupAction[] = [];

  const bundleSkills = join(paths.pluginRoot, ".github", "skills");
  if (relative(bundleSkills, paths.projectScopeSkills) !== "") {
    copyDirRecursive(bundleSkills, paths.projectScopeSkills, actions, dryRun);
  }

  const bundleAgents = join(paths.pluginRoot, ".github", "agents");
  if (relative(bundleAgents, paths.projectScopeAgents) !== "") {
    copyDirRecursive(bundleAgents, paths.projectScopeAgents, actions, dryRun);
  }

  ensureFile(paths.copilotInstructions, COPILOT_INSTRUCTIONS_TEMPLATE, actions, dryRun);
  ensureDir(paths.stateDir, actions, dryRun);

  return { ok: true, dryRun, scope, actions, paths };
}

export function formatSetup(result: SetupResult): string {
  const prefix = result.dryRun ? "DRY-RUN" : "PASS";
  const lines = [`${prefix}: omp setup (scope=${result.scope})`];
  for (const action of result.actions) {
    lines.push(`  [${action.kind}] ${action.target}`);
  }
  return lines.join("\n");
}
