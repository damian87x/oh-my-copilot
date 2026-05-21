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
      .map((name) => path.join(paths.packageRoot, '.agents', 'skills', name, 'SKILL.md'))
      .filter((file) => existsSync(file))
      .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}

describe('Copilot projection dry-run', () => {
  it('projects slash-command wrappers for all MVP commands', () => {
    const before = hashCanonicalSkills();
    const files = projectCopilotCommands();
    const after = hashCanonicalSkills();
    const output = formatDryRun(files);

    expect(after).toEqual(before);
    for (const command of ['grill', 'grill-me', 'ralplan', 'team', 'ralph', 'verify', 'jira-ticket', 'code-review', 'qa']) {
      expect(files.map((file) => file.path)).toContain(`.github/copilot/commands/${command}.md`);
      expect(output).toContain(`commands/${command}.md`);
    }
    expect(output).toMatch(/dry-run/i);
  });

  it('embeds canonical skill content and uses dedicated handoff sources', () => {
    const files = projectCopilotCommands();
    const grillSkill = files.find((file) => file.path === '.github/copilot/skills/grill/SKILL.md');
    const teamCommand = files.find((file) => file.path === '.github/copilot/commands/team.md');
    const ralphCommand = files.find((file) => file.path === '.github/copilot/commands/ralph.md');

    expect(grillSkill?.content).toContain('## Canonical skill text');
    expect(grillSkill?.content).toContain('Explore existing code, docs, issues, or plans before asking');
    expect(teamCommand?.content).toContain('Source: .agents/skills/team/SKILL.md');
    expect(ralphCommand?.content).toContain('Source: .agents/skills/ralph/SKILL.md');
    expect(teamCommand?.content).toContain('Canonical SHA-256:');
  });
});
