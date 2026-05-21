import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ProjectPaths {
  cwd: string;
  packageRoot: string;
  workspaceRoot: string;
  catalogDir: string;
  defaultSkillsRoot: string;
}

export interface ProjectInspection extends ProjectPaths {
  hasAgentsSkills: boolean;
  hasCatalog: boolean;
  hasPackageJson: boolean;
}

export function findUp(start: string, marker: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, marker))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function packageRootFromImportMeta(importMetaUrl: string): string {
  const moduleDir = dirname(fileURLToPath(importMetaUrl));
  const directRoot = resolve(moduleDir, "..");
  if (existsSync(join(directRoot, "catalog")) || existsSync(join(directRoot, "package.json"))) {
    return directRoot;
  }
  const found = findUp(moduleDir, "package.json");
  return found ?? directRoot;
}

function inferPackageRoot(cwd: string): string {
  const localPackage = findUp(cwd, "package.json");
  if (localPackage) {
    return localPackage;
  }
  const childPackage = join(cwd, "oh-my-copilot", "package.json");
  if (existsSync(childPackage)) {
    return join(cwd, "oh-my-copilot");
  }
  return cwd;
}

export function resolveProjectPaths(options: { cwd?: string; packageRoot?: string } = {}): ProjectPaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const packageRoot = resolve(options.packageRoot ?? inferPackageRoot(cwd));
  const workspaceRoot = dirname(packageRoot);
  return {
    cwd,
    packageRoot,
    workspaceRoot,
    catalogDir: join(packageRoot, "catalog"),
    defaultSkillsRoot: join(workspaceRoot, ".agents", "skills"),
  };
}

export function inspectProject(options: { cwd?: string; packageRoot?: string } = {}): ProjectInspection {
  const paths = resolveProjectPaths(options);
  return {
    ...paths,
    hasAgentsSkills: existsSync(paths.defaultSkillsRoot),
    hasCatalog: existsSync(paths.catalogDir),
    hasPackageJson: existsSync(join(paths.packageRoot, "package.json")),
  };
}

export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}
