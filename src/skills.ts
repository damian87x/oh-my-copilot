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
  displayName: string;
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
    throw new Error(`invalid skill directory name ${JSON.stringify(skillName)} for ${skillFile}: the directory name is the skill identity/command and must match ${SAFE_SKILL_NAME} — rename the directory (the human-readable frontmatter \`name\` can stay as-is)`);
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
  // Per the Agent Skills spec (https://code.claude.com/docs/en/skills) the
  // DIRECTORY name is the skill identity ("the directory name becomes the
  // command"); frontmatter `name` is an optional free-form DISPLAY string that
  // defaults to the directory. So the install target is derived from — and the
  // path-safety check applied to — the directory, not the display name.
  const skillName = basename(sourceDir);
  const displayName = frontmatter.name || skillName;
  if (!frontmatter.description) throw new Error(`missing skill description in ${skillFile}`);
  assertSafeSkillName(skillName, skillFile);

  // Default user home so a one-off install never lands in the project tree.
  const scope = options.scope ?? 'user';
  const targetRoot = scope === 'project'
    ? join(resolveProjectPaths({ cwd, packageRoot: options.root }).packageRoot, '.github', 'skills')
    : resolve(options.userSkillsRoot ?? join(homedir(), '.copilot', 'skills'));
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
    displayName,
    sourceDir,
    targetDir,
    files,
  };
}

export function formatSkillInstall(result: SkillInstallResult): string {
  const action = result.dryRun ? 'DRY-RUN' : 'PASS';
  const title = result.displayName && result.displayName !== result.skillName
    ? `/${result.skillName} (${result.displayName})`
    : `/${result.skillName}`;
  return [
    `${action}: skill install ${title}`,
    `source=${result.sourceDir}`,
    `target=${result.targetDir}`,
    ...result.files.map((file) => `- ${file}`),
  ].join('\n');
}
