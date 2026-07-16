import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { packageRootFromImportMeta, resolveProjectPaths } from "../project.js";

export interface CopilotPaths {
  packageRoot: string;
  projectRoot: string;
  pluginRoot: string;
  stateDir: string;
  hooksLogPath: string;
  userScope: string;
  /** Personal skills root: ~/.copilot/skills (or $COPILOT_HOME/skills). */
  userScopeSkills: string;
  /** Personal agents root: ~/.copilot/agents (or $COPILOT_HOME/agents). */
  userScopeAgents: string;
  projectScopeSkills: string;
  projectScopeAgents: string;
  copilotInstructions: string;
  hooksManifest: string;
  scriptsDir: string;
}

export interface ResolveCopilotPathsOptions {
  cwd?: string;
  projectRoot?: string;
  pluginRoot?: string;
  importMetaUrl?: string;
  /** Override the copilot home dir (defaults to $COPILOT_HOME, then ~/.copilot).
   *  Used by tests and to honor copilot's own COPILOT_HOME relocation. */
  copilotHome?: string;
}

export function resolveCopilotPaths(options: ResolveCopilotPathsOptions = {}): CopilotPaths {
  const proj = resolveProjectPaths({ cwd: options.cwd, packageRoot: options.projectRoot });
  const projectRoot = proj.packageRoot;
  // pluginRoot is where omp's bundle lives (hooks/, .github/skills, scripts/) —
  // the omp PACKAGE, not the caller's cwd project. Default to THIS module's own
  // package root so callers that don't pass importMetaUrl (bare launch, `omp
  // update`) still locate the bundled hooks/skills. Without this, packageRoot
  // fell back to the cwd project (no hooks.json there) and hook install silently
  // no-op'd — the real cause of "omp update / bare omp installs no hooks".
  const packageRoot = options.importMetaUrl
    ? packageRootFromImportMeta(options.importMetaUrl)
    : packageRootFromImportMeta(import.meta.url);
  const envPluginRoot = process.env.OMP_PLUGIN_ROOT ?? process.env.OMC_PLUGIN_ROOT;
  const pluginRoot = options.pluginRoot
    ? resolve(options.pluginRoot)
    : envPluginRoot
    ? resolve(envPluginRoot)
    : packageRoot;
  const stateDir = join(projectRoot, ".omp", "state");
  const userScope = resolve(
    options.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
  );
  return {
    packageRoot,
    projectRoot,
    pluginRoot,
    stateDir,
    hooksLogPath: join(stateDir, "hooks.log"),
    userScope,
    userScopeSkills: join(userScope, "skills"),
    userScopeAgents: join(userScope, "agents"),
    projectScopeSkills: join(projectRoot, ".github", "skills"),
    projectScopeAgents: join(projectRoot, ".github", "agents"),
    copilotInstructions: join(projectRoot, ".github", "copilot-instructions.md"),
    hooksManifest: join(pluginRoot, "hooks", "hooks.json"),
    scriptsDir: join(pluginRoot, "scripts"),
  };
}

export function ensureStateDir(paths: CopilotPaths): void {
  if (!existsSync(paths.stateDir)) mkdirSync(paths.stateDir, { recursive: true });
}
