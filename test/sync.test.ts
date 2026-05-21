import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { formatDryRun, projectCopilotCommands } from '../src/sync.js';
import { resolveProjectPaths } from '../src/project.js';

function hashCanonicalSkills() {
  const paths = resolveProjectPaths({ cwd: process.cwd() });
  return Object.fromEntries(
    ['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa']
      .map((name) => path.join(paths.packageRoot, '.github', 'skills', name, 'SKILL.md'))
      .filter((file) => existsSync(file))
      .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}

describe('Copilot skills dry-run', () => {
  it('projects Copilot project skills for all MVP commands', () => {
    const before = hashCanonicalSkills();
    const files = projectCopilotCommands();
    const after = hashCanonicalSkills();
    const output = formatDryRun(files);

    expect(after).toEqual(before);
    for (const command of ['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa']) {
      expect(files.map((file) => file.path)).toContain(`.github/skills/${command}/SKILL.md`);
      expect(output).toContain(`skills/${command}/SKILL.md`);
    }
    expect(output).toMatch(/dry-run/i);
  });

  it('keeps skill bodies in official Copilot skill locations', () => {
    const files = projectCopilotCommands();
    const grillSkill = files.find((file) => file.path === '.github/skills/grill/SKILL.md');
    const teamSkill = files.find((file) => file.path === '.github/skills/team/SKILL.md');
    const ralphSkill = files.find((file) => file.path === '.github/skills/ralph/SKILL.md');

    expect(grillSkill?.content).toContain('Explore existing code, docs, issues, or plans before asking');
    expect(teamSkill?.content).toContain('Do not emulate a durable team runtime');
    expect(ralphSkill?.content).toContain('Do not emulate a durable runtime');
    expect(files.map((file) => file.path).some((path) => path.startsWith('.github/copilot/'))).toBe(false);
  });
});
