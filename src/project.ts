import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ProjectPaths {
  cwd: string;
  packageRoot: string;
  repoRoot: string;
  catalogDir: string;
  defaultSkillsRoot: string;
}

export interface ProjectInspection extends ProjectPaths {
  hasCopilotSkills: boolean;
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

export function packageRoot(...segments: string[]): string {
  return resolve(findUp(process.cwd(), "package.json") ?? process.cwd(), ...segments);
}

export function repoRoot(...segments: string[]): string {
  return resolve(packageRoot(), ...segments);
}

function inferPackageRoot(cwd: string): string {
  const gitRoot = findUp(cwd, ".git");
  const localPackage = findUp(cwd, "package.json");
  if (gitRoot) {
    const packageRelativeToGit = localPackage ? relative(gitRoot, localPackage) : undefined;
    const packageIsInsideGit = packageRelativeToGit !== undefined
      && (packageRelativeToGit === ""
        || (packageRelativeToGit !== ".."
          && !packageRelativeToGit.startsWith(`..${sep}`)
          && !isAbsolute(packageRelativeToGit)));
    return packageIsInsideGit && localPackage ? localPackage : gitRoot;
  }
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
  const resolvedPackageRoot = resolve(options.packageRoot ?? inferPackageRoot(cwd));
  const resolvedRepoRoot = resolvedPackageRoot;
  return {
    cwd,
    packageRoot: resolvedPackageRoot,
    repoRoot: resolvedRepoRoot,
    catalogDir: join(resolvedPackageRoot, "catalog"),
    defaultSkillsRoot: join(resolvedRepoRoot, ".github", "skills"),
  };
}

export function inspectProject(options: { cwd?: string; packageRoot?: string } = {}): ProjectInspection {
  const paths = resolveProjectPaths(options);
  return {
    ...paths,
    hasCopilotSkills: existsSync(paths.defaultSkillsRoot),
    hasCatalog: existsSync(paths.catalogDir),
    hasPackageJson: existsSync(join(paths.packageRoot, "package.json")),
  };
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function listSkillNames(root = repoRoot()): string[] {
  const skillsDir = join(root, ".github", "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function parseFrontmatter(text: string): Record<string, string> {
  // Locate the first `---` frontmatter block, tolerating a leading BOM, blank
  // lines, or an HTML/license comment before it. Some upstream skills (e.g.
  // Anthropic's) put a copyright comment first; the spec still treats the first
  // `---`-delimited block as frontmatter. (In JS regex `\s` also matches U+FEFF,
  // so a leading BOM is stripped by the same pass.)
  const stripped = text.replace(/^\s*(?:<!--[\s\S]*?-->\s*)*/, "");
  if (!stripped.startsWith("---")) return {};
  const end = stripped.indexOf("\n---", 3);
  if (end === -1) return {};
  const frontmatter = stripped.slice(3, end).trim();
  const result: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    result[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
  return result;
}

export function toFileUrl(path: string): string {
  return pathToFileURL(path).href;
}
