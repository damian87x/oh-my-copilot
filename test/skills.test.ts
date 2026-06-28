import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installSkill } from '../src/skills.js';

function tempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-skill-install-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}');
  return root;
}

function tempSkill() {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-skill-source-'));
  const skill = path.join(root, 'skills', 'hello-skill');
  mkdirSync(path.join(skill, 'references'), { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: hello-skill\ndescription: Say hello with /hello-skill.\n---\n\n# Hello\n');
  writeFileSync(path.join(skill, 'references', 'notes.md'), '# Notes\n');
  return skill;
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
});
