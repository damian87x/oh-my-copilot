import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSkill } from '../src/skills.js';

type SkillScope = 'project' | 'user';

function tempRepo() {
  const parent = mkdtempSync(path.join(tmpdir(), 'omc-skill-install-'));
  const root = path.join(parent, 'repo');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}');
  return root;
}

function tempSkill(name = 'hello-skill') {
  const root = mkdtempSync(path.join(tmpdir(), 'omc-skill-source-'));
  const skill = path.join(root, 'skills', 'fixture-skill');
  mkdirSync(path.join(skill, 'references'), { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Say hello.\n---\n\n# Hello\n`);
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
    const source = tempSkill();

    const result = installSkill({ cwd: repo, root: repo, source, dryRun: true });

    expect(result.skillName).toBe('hello-skill');
    expect(result.targetDir).toBe(path.join(repo, '.github', 'skills', 'hello-skill'));
    expect(result.files).toEqual(['SKILL.md', 'references/notes.md']);
    expect(existsSync(result.targetDir)).toBe(false);
  });

  it('installs a fetched skill package into .github/skills', () => {
    const repo = tempRepo();
    const source = tempSkill();

    const result = installSkill({ cwd: repo, root: repo, source });

    expect(result.dryRun).toBe(false);
    expect(readFileSync(path.join(result.targetDir, 'SKILL.md'), 'utf8')).toContain('hello-skill');
    expect(readFileSync(path.join(result.targetDir, 'references', 'notes.md'), 'utf8')).toContain('Notes');
  });

  it.each<SkillScope>(['project', 'user'])('rejects traversal skill names before writing files in %s scope', (scope) => {
    const repo = tempRepo();
    const source = tempSkill('../../../x');
    const userSkillsRoot = tempUserSkillsRoot(repo);
    const targetRoot = targetRootFor(scope, repo, userSkillsRoot);
    const escapedTarget = path.resolve(targetRoot, '../../../x');

    expect(() => installForScope(scope, repo, source, userSkillsRoot)).toThrow(/invalid skill name/);
    expect(existsSync(targetRoot)).toBe(false);
    expect(existsSync(escapedTarget)).toBe(false);
  });

  it.each<SkillScope>(['project', 'user'])('rejects absolute-path skill names before writing files in %s scope', (scope) => {
    const repo = tempRepo();
    const absoluteName = path.join(path.dirname(repo), 'absolute-skill');
    const source = tempSkill(absoluteName);
    const userSkillsRoot = tempUserSkillsRoot(repo);
    const targetRoot = targetRootFor(scope, repo, userSkillsRoot);

    expect(() => installForScope(scope, repo, source, userSkillsRoot)).toThrow(/invalid skill name/);
    expect(existsSync(targetRoot)).toBe(false);
    expect(existsSync(absoluteName)).toBe(false);
  });

  it.each<SkillScope>(['project', 'user'])('installs safe skill names in %s scope', (scope) => {
    const repo = tempRepo();
    const source = tempSkill('valid.skill_2');
    const userSkillsRoot = tempUserSkillsRoot(repo);
    const targetRoot = targetRootFor(scope, repo, userSkillsRoot);

    const result = installForScope(scope, repo, source, userSkillsRoot);

    expect(result.skillName).toBe('valid.skill_2');
    expect(result.targetDir).toBe(path.join(targetRoot, 'valid.skill_2'));
    expect(readFileSync(path.join(result.targetDir, 'SKILL.md'), 'utf8')).toContain('valid.skill_2');
    expect(readFileSync(path.join(result.targetDir, 'references', 'notes.md'), 'utf8')).toContain('Notes');
  });

  it.each<SkillScope>(['project', 'user'])('overwrites only the existing skill target in %s scope', (scope) => {
    const repo = tempRepo();
    const source = tempSkill('replace-me');
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
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toContain('replace-me');
    expect(readFileSync(path.join(siblingDir, 'marker.txt'), 'utf8')).toBe('keep me');
  });
});
