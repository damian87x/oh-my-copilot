import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalogBundle, type SkillProjection } from './catalog.js';
import { packageRootFromImportMeta } from './project.js';

export interface ProjectionFile {
  path: string;
  content: string;
}

const REQUIRED_COMMANDS = ['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa'];

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*([A-Za-z0-9_-]+)\s*}}/g, (_match, key: string) => vars[key] ?? '');
}

function commandBody(skill: SkillProjection): string {
  if (skill.handoffOnly || skill.projection === 'capability-handoff') {
    return thinHandoffBody(skill.name);
  }
  if (skill.name === 'jira-ticket') {
    return 'Use configured provider credentials only from environment or approved local configuration. If configuration is missing, emit a dry-run payload instead of failing silently.';
  }
  if (skill.name === 'code-review' || skill.name === 'qa') {
    return 'Run this as a portable gate. If an opposite/non-author model or QA runtime is available, hand off to it; otherwise produce structured findings and explicit evidence.';
  }
  return 'Read the canonical provider-neutral skill text, adapt invocation syntax for this provider, and keep the skill behavior unchanged.';
}

function thinHandoffBody(name: string): string {
  return [
    `This Phase 1 /${name} command is a thin capability handoff, not a Copilot-native durable runtime.`,
    'If the current provider exposes an equivalent runtime, call it with the user request and preserve evidence.',
    'If no runtime exists, emit a clear unsupported handoff with recommended next command and required context.',
  ].join('\n\n');
}

function fallbackFor(skill: SkillProjection): string {
  if (skill.handoffOnly || skill.projection === 'capability-handoff') {
    return 'No runtime available: return a handoff brief with context, owner model, risks, and verification checklist.';
  }
  if (skill.name === 'jira-ticket') {
    return 'No Jira config or live permission: render exact create/comment/safe-update payloads for copy/paste.';
  }
  return 'Missing source skill: report the missing path and stop before inventing provider-specific behavior.';
}

function canonicalSkill(skill: SkillProjection, packageRoot: string): { path: string; text: string; sha256: string } {
  const canonicalPath = resolve(packageRoot, skill.sourcePath);
  if (!existsSync(canonicalPath)) {
    throw new Error(`missing canonical skill source for ${skill.name}: ${skill.sourcePath}`);
  }
  const text = readFileSync(canonicalPath, 'utf8');
  return {
    path: canonicalPath,
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function varsFor(skill: SkillProjection, command: string, packageRoot: string, aliasOf?: string): Record<string, string> {
  const canonical = canonicalSkill(skill, packageRoot);
  return {
    name: command,
    command,
    title: aliasOf ? `${command} alias` : command,
    description: aliasOf ? `Alias for /${aliasOf}` : skill.summary,
    source: skill.sourcePath,
    canonicalPath: skill.sourcePath,
    canonicalAbsolutePath: canonical.path,
    canonicalSha256: canonical.sha256,
    canonicalText: canonical.text,
    support: aliasOf ? 'alias' : skill.projection,
    capability: skill.capabilityId,
    capabilityIds: skill.capabilityId,
    aliases: skill.aliases.join(', ') || 'none',
    body: aliasOf ? `Invoke /${aliasOf}. This file exists for backward compatibility.` : commandBody(skill),
    fallback: fallbackFor(skill),
  };
}

function assertRequiredCommands(files: ProjectionFile[]): void {
  const projected = new Set(files
    .map((file) => file.path.match(/\.github\/copilot\/commands\/([^/]+)\.md$/)?.[1])
    .filter((command): command is string => Boolean(command)));
  const missing = REQUIRED_COMMANDS.filter((command) => !projected.has(command));
  if (missing.length > 0) throw new Error(`missing required Copilot slash projections: ${missing.map((command) => `/${command}`).join(', ')}`);
}

export function projectCopilotCommands(): ProjectionFile[] {
  const packageRoot = packageRootFromImportMeta(import.meta.url);
  const bundle = loadCatalogBundle(resolve(packageRoot, 'catalog'));
  const commandTemplate = readFileSync(resolve(packageRoot, 'templates/copilot-command.md.hbs'), 'utf8');
  const skillTemplate = readFileSync(resolve(packageRoot, 'templates/skill-wrapper.md.hbs'), 'utf8');
  const files: ProjectionFile[] = [];
  const emittedCommands = new Set<string>();

  function emitCommand(skill: SkillProjection, command: string, aliasOf?: string): void {
    if (emittedCommands.has(command)) return;
    emittedCommands.add(command);
    const vars = varsFor(skill, command, packageRoot, aliasOf);
    files.push({
      path: `.github/copilot/commands/${command}.md`,
      content: render(commandTemplate, vars),
    });

    if (skill.projection === 'skill-wrapper' || aliasOf) {
      files.push({
        path: `.github/copilot/skills/${command}/SKILL.md`,
        content: render(skillTemplate, vars),
      });
    }
  }

  for (const skill of bundle.skills.skills) {
    const commands = skill.slashCommands.length > 0 ? skill.slashCommands : [skill.name, ...skill.aliases];
    for (const command of commands) emitCommand(skill, command, command === skill.name ? undefined : skill.name);
  }

  assertRequiredCommands(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatDryRun(files = projectCopilotCommands()): string {
  return ['PASS: Copilot projection dry-run', ...files.map((file) => `- ${file.path} (${file.content.length} bytes)`)].join('\n');
}
