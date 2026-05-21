import { describe, expect, it } from 'vitest';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { lintSkills } from '../src/lint.js';
import { resolveProjectPaths } from '../src/project.js';

describe('skill portability lint', () => {
  it('passes committed canonical skills without catalog errors', () => {
    const issues = lintSkills({ cwd: process.cwd() });
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('keeps provider-specific command examples out of canonical general skills', () => {
    const paths = resolveProjectPaths({ cwd: process.cwd() });
    for (const name of ['grill', 'grill-me', 'verify', 'jira-ticket', 'code-review', 'qa']) {
      const skillFile = path.join(paths.packageRoot, '.agents', 'skills', name, 'SKILL.md');
      const body = readFileSync(skillFile, 'utf8');
      expect(body, `${name} avoids Codex command syntax`).not.toMatch(/\$ralph|\$team|\$ralplan/i);
      expect(body, `${name} avoids runtime state coupling`).not.toMatch(/OMX_TEAM_STATE_ROOT|TMUX_PANE|tmux-only/i);
    }
  });

  it('links Claude skills to repo-local canonical agents skills', () => {
    const paths = resolveProjectPaths({ cwd: process.cwd() });
    const link = path.join(paths.packageRoot, '.claude', 'skills');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../.agents/skills');
  });

});
