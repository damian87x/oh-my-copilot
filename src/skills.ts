import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter, resolveProjectPaths } from './project.js';

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export interface SkillInstallOptions {
  cwd?: string;
  root?: string;
  source: string;
  scope?: 'project' | 'user';
  dryRun?: boolean;
  userSkillsRoot?: string;
}

export interface SkillInstallResult {
  ok: boolean;
  dryRun: boolean;
  skillName: string;
  sourceDir: string;
  targetDir: string;
  files: string[];
}

function findSkillDir(input: string, cwd: string): string {
  const direct = resolve(cwd, input);
  if (existsSync(join(direct, 'SKILL.md'))) return direct;
  if (existsSync(direct) && statSync(direct).isFile() && basename(direct) === 'SKILL.md') {
    return resolve(direct, '..');
  }
  throw new Error(`skill source must be a directory containing SKILL.md: ${input}`);
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path, base);
    return [path.slice(base.length + 1)];
  }).sort();
}

function assertSafeSkillName(skillName: string, skillFile: string): void {
  if (!SAFE_SKILL_NAME.test(skillName)) {
    throw new Error(`invalid skill name in ${skillFile}: ${JSON.stringify(skillName)} (must match ${SAFE_SKILL_NAME})`);
  }
}

function assertTargetInsideRoot(targetRoot: string, targetDir: string): void {
  const resolvedRoot = resolve(targetRoot);
  const resolvedTarget = resolve(targetDir);
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`skill target must stay inside skills root: ${resolvedTarget}`);
  }
}

export function installSkill(options: SkillInstallOptions): SkillInstallResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const sourceDir = findSkillDir(options.source, cwd);
  const skillFile = join(sourceDir, 'SKILL.md');
  const frontmatter = parseFrontmatter(readFileSync(skillFile, 'utf8'));
  const skillName = frontmatter.name || basename(sourceDir);
  if (!frontmatter.name) throw new Error(`missing skill name in ${skillFile}`);
  if (!frontmatter.description) throw new Error(`missing skill description in ${skillFile}`);
  assertSafeSkillName(skillName, skillFile);

  const scope = options.scope ?? 'project';
  const targetRoot = scope === 'user'
    ? resolve(options.userSkillsRoot ?? join(homedir(), '.copilot', 'skills'))
    : join(resolveProjectPaths({ cwd, packageRoot: options.root }).packageRoot, '.github', 'skills');
  const targetDir = join(targetRoot, skillName);
  assertTargetInsideRoot(targetRoot, targetDir);
  const files = listFiles(sourceDir);

  if (!options.dryRun) {
    mkdirSync(targetRoot, { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
  }

  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    skillName,
    sourceDir,
    targetDir,
    files,
  };
}

export function formatSkillInstall(result: SkillInstallResult): string {
  const action = result.dryRun ? 'DRY-RUN' : 'PASS';
  return [
    `${action}: skill install /${result.skillName}`,
    `source=${result.sourceDir}`,
    `target=${result.targetDir}`,
    ...result.files.map((file) => `- ${file}`),
  ].join('\n');
}
