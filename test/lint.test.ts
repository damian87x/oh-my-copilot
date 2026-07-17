import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lintSkills } from '../src/lint.js';
import { listSkillNames, resolveProjectPaths } from '../src/project.js';

function tempLintProject() {
  const root = mkdtempSync(path.join(tmpdir(), 'omc-lint-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}');
  return root;
}

function writeCatalog(root: string, skillName: string, aliases: string[] = []) {
  const catalog = path.join(root, 'catalog');
  mkdirSync(catalog, { recursive: true });
  const skillEntries = [
    { name: skillName, aliases },
    ...(skillName === 'grill-me' ? [] : [{ name: 'grill-me', aliases: [] }]),
  ];
  writeFileSync(path.join(catalog, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    providerStates: ['native', 'handoff', 'stub', 'unsupported'],
    compatProviderStates: ['supported', 'fallback', 'unsupported'],
    capabilities: skillEntries.map((entry) => ({
      id: entry.name,
      name: entry.name,
      title: entry.name,
      category: 'verification',
      summary: 'Test capability.',
      notes: 'Fixture.',
      defaultCommand: entry.name,
      phase1: true,
      sourceSkill: entry.name,
      providers: { copilot: 'supported' },
      support: { copilot: 'native' },
      providerSupport: { copilot: { state: 'native', notes: 'Fixture.' } },
    })),
  }, null, 2));
  writeFileSync(path.join(catalog, 'skills-general.json'), JSON.stringify({
    schemaVersion: 1,
    canonicalRoot: '.github/skills',
    commandPrefix: '/',
    skills: skillEntries.map((entry) => ({
      name: entry.name,
      capabilityId: entry.name,
      capabilityIds: [entry.name],
      source: `.github/skills/${entry.name}/SKILL.md`,
      sourcePath: `.github/skills/${entry.name}/SKILL.md`,
      canonicalPath: `.github/skills/${entry.name}/SKILL.md`,
      description: 'Test skill.',
      summary: 'Test skill.',
      support: 'project-skill',
      aliases: entry.aliases,
      slashCommands: [entry.name],
      projections: { copilot: { command: `/${entry.name}`, state: 'supported' } },
      projection: 'project-skill',
      phase1: true,
    })),
  }, null, 2));
  if (skillName !== 'grill-me') {
    writeSkill(root, 'grill-me', 'name: grill-me\ndescription: Required fixture skill.\n');
  }
}

function writeSkill(root: string, dir: string, frontmatter: string) {
  const skillDir = path.join(root, '.github', 'skills', dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${frontmatter}---\n\n# ${dir}\n`);
}

describe('skill portability lint', () => {
  it('passes committed canonical skills without catalog errors', () => {
    const issues = lintSkills({ cwd: process.cwd() });
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues.filter((issue) => issue.level === 'warning')).toEqual([]);
  });

  it('keeps runtime-specific command examples out of Copilot skills', () => {
    const paths = resolveProjectPaths({ cwd: process.cwd() });
    const skillNames = listSkillNames(paths.packageRoot);
    const dollarCommandPattern = new RegExp(`\\$(?:${skillNames.join('|')})\\b`, 'i');
    const runtimePathPattern = /(?:\.claude(?:-plugin)?|\.agents|\.omx|\.github\/copilot)\//i;
    for (const name of skillNames) {
      const skillFile = path.join(paths.packageRoot, '.github', 'skills', name, 'SKILL.md');
      const body = readFileSync(skillFile, 'utf8');
      expect(body, `${name} uses slash skill syntax`).toContain(`/${name}`);
      expect(body, `${name} avoids dollar command syntax`).not.toMatch(dollarCommandPattern);
      expect(body, `${name} avoids runtime state coupling`).not.toMatch(/OMX_TEAM_STATE_ROOT|TMUX_PANE|tmux-only/i);
      expect(body, `${name} avoids runtime path coupling`).not.toMatch(runtimePathPattern);
    }
  });

  it('uses only Copilot project skills without compatibility skill roots', () => {
    const paths = resolveProjectPaths({ cwd: process.cwd() });
    expect(existsSync(path.join(paths.packageRoot, '.github', 'skills'))).toBe(true);
    expect(existsSync(path.join(paths.packageRoot, '.agents'))).toBe(false);
    expect(existsSync(path.join(paths.packageRoot, '.claude'))).toBe(false);
  });

  it('does not warn when an installed skill omits optional display name', () => {
    const root = tempLintProject();
    writeCatalog(root, 'nameless');
    writeSkill(root, 'nameless', 'description: No display name needed.\n');

    const issues = lintSkills({ cwd: root, packageRoot: root });

    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues.some((issue) => issue.code === 'skill.name')).toBe(false);
  });

  it('warns about display-name mismatches without treating them as missing skills', () => {
    const root = tempLintProject();
    writeCatalog(root, 'clawteam');
    writeSkill(root, 'clawteam', 'name: ClawTeam\ndescription: Team coordination.\n');

    const issues = lintSkills({ cwd: root, packageRoot: root });

    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({
      level: 'warning',
      code: 'skill.name',
      message: expect.stringContaining('directory "clawteam"'),
    }));
    expect(issues.find((issue) => issue.code === 'skill.name')?.message).toContain('name is display');
    expect(issues.some((issue) => issue.code === 'skill.missing')).toBe(false);
  });

  it('allows catalog aliases to match a display name without a mismatch warning', () => {
    const root = tempLintProject();
    writeCatalog(root, 'clawteam', ['ClawTeam']);
    writeSkill(root, 'clawteam', 'name: ClawTeam\ndescription: Team coordination.\n');

    const issues = lintSkills({ cwd: root, packageRoot: root });

    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues.some((issue) => issue.code === 'skill.name')).toBe(false);
  });

});
