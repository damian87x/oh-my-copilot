import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";
import { atomicWrite } from "../utils/fs.js";

export interface SetupOptions extends ResolveCopilotPathsOptions {
  dryRun?: boolean;
  scope?: "project" | "user";
  /** Overwrite bundled skills/agents that exist but differ from the bundle.
   *  Without it, changed files are reported as "skip-changed" (the CLI offers an
   *  interactive override); identical files are always skipped. */
  force?: boolean;
}

export type SetupActionKind =
  | "copy"
  | "create"
  | "update"
  | "skip-exists"
  | "skip-changed"
  | "skip-source-missing"
  | "skip-source-invalid";

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

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function copyDirRecursive(
  source: string,
  target: string,
  actions: SetupAction[],
  dryRun: boolean,
  force: boolean,
): void {
  if (!existsSync(source)) {
    actions.push({ source, target, kind: "skip-source-missing" });
    return;
  }
  if (!dryRun && !existsSync(target)) mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sPath = join(source, entry.name);
    const tPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sPath, tPath, actions, dryRun, force);
    } else if (entry.isFile()) {
      if (existsSync(tPath)) {
        // Identical → always skip. Differs → skip unless forced (the CLI offers
        // an override prompt), so updated bundled skills can actually propagate.
        if (filesEqual(sPath, tPath)) {
          actions.push({ source: sPath, target: tPath, kind: "skip-exists" });
          continue;
        }
        if (!force) {
          actions.push({ source: sPath, target: tPath, kind: "skip-changed" });
          continue;
        }
        if (!dryRun) {
          mkdirSync(dirname(tPath), { recursive: true });
          copyFileSync(sPath, tPath);
        }
        actions.push({ source: sPath, target: tPath, kind: "update" });
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
    atomicWrite(target, content);
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

// Copilot only loads hooks from user (`~/.copilot/hooks/*.json`) or project
// (`.github/hooks/*.json`) locations — NOT from a plugin's own hooks/hooks.json.
// So omp's lifecycle hooks (sessionEnd → memory-review, cost ledger, etc.) never
// fire until we install them into one of those locations (this is how Orca's
// orca.json works). The file is machine-local (absolute node script paths), so
// it always goes to the user location regardless of skills/agents scope.
const HOOK_FILE_NAME = "omp.json";

/** Pin the plugin root for a hook command. The bundled hooks.json resolves its
 *  script dir from `${COPILOT_PLUGIN_ROOT:-…}`, but copilot does NOT set that var
 *  for user/project hook files (only for plugin-context hooks). We `export` the
 *  vars as a SEPARATE statement first: an assignment prefix on the same simple
 *  command (`VAR=x node "${VAR:-…}"`) is NOT visible to that command's own
 *  parameter expansion, so it must be exported before the command runs. */
function pinPluginRoot(bash: string, pluginRoot: string): string {
  const esc = pluginRoot.replace(/'/g, "'\\''");
  return `export COPILOT_PLUGIN_ROOT='${esc}' OMP_PLUGIN_ROOT='${esc}'; ${bash}`;
}

function installHooks(paths: CopilotPaths, dryRun: boolean, actions: SetupAction[]): void {
  const source = paths.hooksManifest;
  if (!existsSync(source)) {
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-missing" });
    return;
  }
  let manifest: { version?: number; hooks?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    // Present but unparseable — surface it rather than masking as "missing".
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-invalid" });
    return;
  }
  const hooks = manifest.hooks;
  if (!hooks || typeof hooks !== "object") {
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-invalid" });
    return;
  }
  // Rewrite every command's bash to pin the absolute plugin root.
  for (const handlers of Object.values(hooks)) {
    if (!Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      if (handler && typeof handler === "object" && typeof (handler as { bash?: unknown }).bash === "string") {
        const h = handler as { bash: string };
        h.bash = pinPluginRoot(h.bash, paths.pluginRoot);
      }
    }
  }

  const target = join(paths.userScope, "hooks", HOOK_FILE_NAME);
  // Managed, generated file — refresh on every setup so updated script paths /
  // new events propagate (unlike copied skills, which we never clobber).
  const kind: SetupActionKind = existsSync(target) ? "update" : "create";
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
  }
  actions.push({ source, target, kind });
}

/** Absolute path of the user-level hook file omp installs/refreshes. Lets callers
 *  (e.g. bare-launch first-run setup) cheaply check "are hooks installed?". */
export function userHookPath(options: SetupOptions = {}): string {
  return join(resolveCopilotPaths(options).userScope, "hooks", HOOK_FILE_NAME);
}

/** True when the user-level hooks should be (re)installed: either missing, or the
 *  PINNED plugin root in the installed omp.json differs from where omp now runs
 *  (e.g. an nvm node switch / reinstall moved the install path, leaving the hook
 *  scripts pointing at a stale absolute path). Lets bare `omp` self-repair. */
export function userHooksNeedRefresh(options: SetupOptions = {}): boolean {
  const p = userHookPath(options);
  if (!existsSync(p)) return true;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { hooks?: Record<string, unknown> };
    const current = resolveCopilotPaths(options).pluginRoot;
    for (const handlers of Object.values(raw.hooks ?? {})) {
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const bash = (handler as { bash?: unknown })?.bash;
        if (typeof bash !== "string") continue;
        // Quote-aware capture: a single-quoted shell value is non-quote chars or
        // the escaped-quote token `'\''`. Greedy `(.*)` would mis-stop on a path
        // that literally contains ` OMP_PLUGIN_ROOT=` and refresh-loop forever.
        const m = bash.match(/COPILOT_PLUGIN_ROOT='((?:[^']|'\\'')*)' OMP_PLUGIN_ROOT=/);
        if (m) {
          const pinned = m[1].replace(/'\\''/g, "'"); // reverse shell-escaping
          return pinned !== current; // stale if it points at a different install
        }
      }
    }
    return false; // no pinned marker found → leave it alone
  } catch {
    return true; // unparseable → reinstall a clean copy
  }
}

/** Install just the user-level hooks (the piece copilot won't load from the
 *  plugin dir). Used by `omp update` to refresh hooks after a self-update without
 *  scaffolding the current project's .github (skills/agents ship via the
 *  marketplace plugin). Idempotent. */
export function installUserHooks(options: SetupOptions = {}): { actions: SetupAction[]; paths: CopilotPaths } {
  const paths = resolveCopilotPaths(options);
  const actions: SetupAction[] = [];
  installHooks(paths, Boolean(options.dryRun), actions);
  return { actions, paths };
}

export function runSetup(options: SetupOptions = {}): SetupResult {
  const paths = resolveCopilotPaths(options);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const scope = options.scope ?? "project";
  const actions: SetupAction[] = [];

  const bundleSkills = join(paths.pluginRoot, ".github", "skills");
  if (relative(bundleSkills, paths.projectScopeSkills) !== "") {
    copyDirRecursive(bundleSkills, paths.projectScopeSkills, actions, dryRun, force);
  }

  const bundleAgents = join(paths.pluginRoot, ".github", "agents");
  if (relative(bundleAgents, paths.projectScopeAgents) !== "") {
    copyDirRecursive(bundleAgents, paths.projectScopeAgents, actions, dryRun, force);
  }

  ensureFile(paths.copilotInstructions, COPILOT_INSTRUCTIONS_TEMPLATE, actions, dryRun);
  ensureDir(paths.stateDir, actions, dryRun);
  installHooks(paths, dryRun, actions);

  return { ok: true, dryRun, scope, actions, paths };
}

export function formatSetup(result: SetupResult): string {
  const prefix = result.dryRun ? "DRY-RUN" : "PASS";
  const lines = [`${prefix}: omp setup (scope=${result.scope})`];
  for (const action of result.actions) {
    lines.push(`  [${action.kind}] ${action.target}`);
  }
  const changed = result.actions.filter((a) => a.kind === "skip-changed").length;
  if (changed > 0) {
    lines.push(`${changed} bundled file(s) differ from your local copies — re-run with --force to override.`);
  }
  return lines.join("\n");
}
