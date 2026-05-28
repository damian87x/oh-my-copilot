import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { formatDryRun, projectCopilotCommands } from '../src/sync.js';
import { listSkillNames, resolveProjectPaths } from '../src/project.js';

function hashCanonicalSkills() {
  const paths = resolveProjectPaths({ cwd: process.cwd() });
  const skills = listSkillNames(paths.packageRoot);
  return Object.fromEntries(
    skills
      .map((name) => path.join(paths.packageRoot, '.github', 'skills', name, 'SKILL.md'))
      .filter((file) => existsSync(file))
      .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}

describe('Copilot skills dry-run', () => {
  it('projects Copilot project skills for all lite slash commands', () => {
    const before = hashCanonicalSkills();
    const files = projectCopilotCommands();
    const after = hashCanonicalSkills();
    const output = formatDryRun(files);
    const skills = listSkillNames();

    expect(after).toEqual(before);
    for (const command of skills) {
      expect(files.map((file) => file.path)).toContain(`.github/skills/${command}/SKILL.md`);
      expect(output).toContain(`skills/${command}/SKILL.md`);
    }
    expect(output).toMatch(/dry-run/i);
  });

  it('keeps skill bodies short and slash-oriented in official Copilot skill locations', () => {
    const files = projectCopilotCommands();
    const research = files.find((file) => file.path === '.github/skills/research-codebase/SKILL.md');
    const autopilot = files.find((file) => file.path === '.github/skills/omp-autopilot/SKILL.md');
    const team = files.find((file) => file.path === '.github/skills/team/SKILL.md');

    expect(research?.content).toContain('Document');
    expect(autopilot?.content).toContain('/research-codebase');
    expect(team?.content).toContain('tmux');
    expect(files.map((file) => file.path).some((filePath) => filePath.startsWith('.github/copilot/'))).toBe(false);
  });
});
