import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatSkillInstall, installSkill } from '../src/skills.js';

type SkillScope = 'project' | 'user';

interface SkillFixtureOptions {
  /** Directory name = the skill identity/command (per the Agent Skills spec). */
  dir?: string;
  /** Optional free-form display `name:` frontmatter. `null` omits it entirely. */
  name?: string | null;
  description?: string | null;
  /** Prepend an HTML/license comment before the `---` frontmatter block. */
  leadingComment?: boolean;
}

function tempRepo() {
  const parent = mkdtempSync(path.join(tmpdir(), 'omc-skill-install-'));
  const root = path.join(parent, 'repo');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}');
  return root;
}

function tempSkill(opts: SkillFixtureOptions = {}) {
  const dir = opts.dir ?? 'fixture-skill';
  const root = mkdtempSync(path.join(tmpdir(), 'omc-skill-source-'));
  const skill = path.join(root, 'skills', dir);
  mkdirSync(path.join(skill, 'references'), { recursive: true });
  const nameLine = opts.name === null ? '' : `name: ${opts.name ?? 'hello-skill'}\n`;
  const descLine = opts.description === null ? '' : `description: ${opts.description ?? 'Say hello.'}\n`;
  const lead = opts.leadingComment ? '<!-- Copyright 2026 Example -->\n' : '';
  writeFileSync(path.join(skill, 'SKILL.md'), `${lead}---\n${nameLine}${descLine}---\n\n# Hello\n`);
  writeFileSync(path.join(skill, 'references', 'notes.md'), '# Notes\n');
  return skill;
}

function tempUserSkillsRoot(repo: string): string {
  return path.join(path.dirname(repo), 'home', '.copilot', 'skills');
}

function targetRootFor(scope: SkillScope, repo: string, userSkillsRoot: string): string {
  return scope === 'user' ? userSkillsRoot : path.join(repo, '.github', 'skills');
}

function installForScope(scope: SkillScope, repo: string, source: string, userSkillsRoot: string) {
  const options = { cwd: repo, root: repo, source, scope };
  if (scope === 'user') {
    return installSkill({ ...options, userSkillsRoot });
  }
  return installSkill(options);
}

describe('skill installer', () => {
  it('dry-runs a fetched skill package without writing files', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'hello-skill' });

    const result = installSkill({ cwd: repo, root: repo, source, dryRun: true });

    // Identity comes from the directory, not the frontmatter name.
    expect(result.skillName).toBe('hello-skill');
    expect(result.targetDir).toBe(path.join(repo, '.github', 'skills', 'hello-skill'));
    expect(result.files).toEqual(['SKILL.md', 'references/notes.md']);
    expect(existsSync(result.targetDir)).toBe(false);
  });

  it('installs a fetched skill package into .github/skills', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'hello-skill' });

    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.dryRun).toBe(false);
    expect(readFileSync(path.join(result.targetDir, 'SKILL.md'), 'utf8')).toContain('description:');
    expect(readFileSync(path.join(result.targetDir, 'references', 'notes.md'), 'utf8')).toContain('Notes');
  });

  it('formats installs with directory identity and frontmatter display name', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'clawteam', name: 'ClawTeam' });

    const result = installSkill({ cwd: repo, root: repo, source });
    const text = formatSkillInstall(result);

    expect(text).toContain('PASS: skill install /clawteam (ClawTeam)');
    expect(text).not.toContain('/ClawTeam');
  });

  it('uses the directory as identity and accepts a Title-Case display name (the ClawTeam case)', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'clawteam', name: 'ClawTeam' });

    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.skillName).toBe('clawteam');
    expect(result.displayName).toBe('ClawTeam');
    expect(result.targetDir).toBe(path.join(repo, '.github', 'skills', 'clawteam'));
  });

  it('accepts a display name with spaces and ampersands', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'verification-quality', name: 'Verification & Quality Assurance' });

    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.skillName).toBe('verification-quality');
    expect(result.displayName).toBe('Verification & Quality Assurance');
  });

  it('treats frontmatter name as optional, defaulting the display to the directory', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'no-name-skill', name: null });

    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.skillName).toBe('no-name-skill');
    expect(result.displayName).toBe('no-name-skill');
  });

  it('parses frontmatter even when a license comment precedes it', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'commented-skill', leadingComment: true });

    // Would previously throw "missing skill description" because the parser
    // required the file to *start* with `---`.
    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.skillName).toBe('commented-skill');
  });

  it('throws when the skill has no description', () => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'no-desc', description: null });

    expect(() => installSkill({ cwd: repo, root: repo, source })).toThrow(/missing skill description/);
  });

  it.each<SkillScope>(['project', 'user'])(
    'treats a path-like frontmatter name as harmless display and cannot escape in %s scope',
    (scope) => {
      const repo = tempRepo();
      // A malicious `name:` is now just a display string — never used as a path.
      const source = tempSkill({ dir: 'fixture-skill', name: '../../../x' });
      const userSkillsRoot = tempUserSkillsRoot(repo);
      const targetRoot = targetRootFor(scope, repo, userSkillsRoot);
      const escapedTarget = path.resolve(targetRoot, '../../../x');

      const result = installForScope(scope, repo, source, userSkillsRoot);

      expect(result.skillName).toBe('fixture-skill');
      expect(result.targetDir).toBe(path.join(targetRoot, 'fixture-skill'));
      expect(existsSync(escapedTarget)).toBe(false);
    },
  );

  it.each<SkillScope>(['project', 'user'])(
    'rejects a directory name that is not path-safe in %s scope',
    (scope) => {
      const repo = tempRepo();
      // The identity (directory) must be path-safe; a space is not allowed.
      const source = tempSkill({ dir: 'bad name' });
      const userSkillsRoot = tempUserSkillsRoot(repo);
      const targetRoot = targetRootFor(scope, repo, userSkillsRoot);

      expect(() => installForScope(scope, repo, source, userSkillsRoot)).toThrow(/invalid skill directory name/);
      expect(existsSync(targetRoot)).toBe(false);
    },
  );

  it.each<SkillScope>(['project', 'user'])('installs safe skill directory names in %s scope', (scope) => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'valid.skill_2' });
    const userSkillsRoot = tempUserSkillsRoot(repo);
    const targetRoot = targetRootFor(scope, repo, userSkillsRoot);

    const result = installForScope(scope, repo, source, userSkillsRoot);

    expect(result.skillName).toBe('valid.skill_2');
    expect(result.targetDir).toBe(path.join(targetRoot, 'valid.skill_2'));
    expect(readFileSync(path.join(result.targetDir, 'references', 'notes.md'), 'utf8')).toContain('Notes');
  });

  it.each<SkillScope>(['project', 'user'])('overwrites only the existing skill target in %s scope', (scope) => {
    const repo = tempRepo();
    const source = tempSkill({ dir: 'replace-me' });
    const userSkillsRoot = tempUserSkillsRoot(repo);
    const targetRoot = targetRootFor(scope, repo, userSkillsRoot);
    const targetDir = path.join(targetRoot, 'replace-me');
    const siblingDir = path.join(targetRoot, 'keep-me');
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'old.txt'), 'remove me');
    writeFileSync(path.join(siblingDir, 'marker.txt'), 'keep me');

    const result = installForScope(scope, repo, source, userSkillsRoot);

    expect(result.targetDir).toBe(targetDir);
    expect(existsSync(path.join(targetDir, 'old.txt'))).toBe(false);
    expect(readFileSync(path.join(siblingDir, 'marker.txt'), 'utf8')).toBe('keep me');
  });
});
