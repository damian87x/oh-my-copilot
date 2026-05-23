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
}

export function resolveCopilotPaths(options: ResolveCopilotPathsOptions = {}): CopilotPaths {
  const proj = resolveProjectPaths({ cwd: options.cwd, packageRoot: options.projectRoot });
  const projectRoot = proj.packageRoot;
  const packageRoot = options.importMetaUrl
    ? packageRootFromImportMeta(options.importMetaUrl)
    : projectRoot;
  const pluginRoot = options.pluginRoot
    ? resolve(options.pluginRoot)
    : process.env.OMC_PLUGIN_ROOT
    ? resolve(process.env.OMC_PLUGIN_ROOT)
    : packageRoot;
  const stateDir = join(projectRoot, ".omc", "state");
  return {
    packageRoot,
    projectRoot,
    pluginRoot,
    stateDir,
    hooksLogPath: join(stateDir, "hooks.log"),
    userScope: join(homedir(), ".copilot"),
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
