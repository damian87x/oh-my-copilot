import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalogBundle, type SkillProjection } from './catalog.js';
import { packageRootFromImportMeta } from './project.js';

export interface ProjectionFile {
  path: string;
  content: string;
}

const REQUIRED_COMMANDS = ['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa'];

function skillSource(command: string, skill: SkillProjection, packageRoot: string): ProjectionFile {
  const directPath = `.github/skills/${command}/SKILL.md`;
  const directAbsolute = resolve(packageRoot, directPath);
  const sourcePath = existsSync(directAbsolute) ? directPath : skill.sourcePath;
  const absolute = resolve(packageRoot, sourcePath);
  if (!existsSync(absolute)) {
    throw new Error(`missing Copilot skill source for /${command}: ${sourcePath}`);
  }
  return {
    path: directPath,
    content: readFileSync(absolute, 'utf8'),
  };
}

function assertRequiredSkills(files: ProjectionFile[]): void {
  const projected = new Set(files
    .map((file) => file.path.match(/\.github\/skills\/([^/]+)\/SKILL\.md$/)?.[1])
    .filter((command): command is string => Boolean(command)));
  const missing = REQUIRED_COMMANDS.filter((command) => !projected.has(command));
  if (missing.length > 0) throw new Error(`missing required Copilot skills: ${missing.map((command) => `/${command}`).join(', ')}`);
}

export function projectCopilotCommands(): ProjectionFile[] {
  const packageRoot = packageRootFromImportMeta(import.meta.url);
  const bundle = loadCatalogBundle(resolve(packageRoot, 'catalog'));
  const files: ProjectionFile[] = [];
  const emittedCommands = new Set<string>();

  function emitSkill(skill: SkillProjection, command: string): void {
    if (emittedCommands.has(command)) return;
    emittedCommands.add(command);
    files.push(skillSource(command, skill, packageRoot));
  }

  for (const skill of bundle.skills.skills) {
    const commands = skill.slashCommands.length > 0 ? skill.slashCommands : [skill.name, ...skill.aliases];
    for (const command of commands) emitSkill(skill, command);
  }

  assertRequiredSkills(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatDryRun(files = projectCopilotCommands()): string {
  return ['PASS: Copilot skills dry-run', ...files.map((file) => `- ${file.path} (${file.content.length} bytes)`)].join('\n');
}
