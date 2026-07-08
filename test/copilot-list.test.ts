import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listAll } from '../src/copilot/list.js';

function tempPackage() {
  const root = mkdtempSync(path.join(tmpdir(), 'omc-list-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"tmp"}');
  return root;
}

describe('listAll skill discovery', () => {
  it('skips an unreadable skill instead of aborting the whole listing', async () => {
    const root = tempPackage();
    const skills = path.join(root, '.github', 'skills');
    // A healthy skill with a Title-Case display name.
    const good = path.join(skills, 'clawteam');
    mkdirSync(good, { recursive: true });
    writeFileSync(path.join(good, 'SKILL.md'), '---\nname: ClawTeam\ndescription: Team coordination.\n---\n');
    // A broken skill whose SKILL.md is a directory (readFileSync throws EISDIR).
    const broken = path.join(skills, 'broken');
    mkdirSync(path.join(broken, 'SKILL.md'), { recursive: true });

    const list = await listAll({ cwd: root, packageRoot: root });

    const names = list.skills.map((s) => s.name);
    expect(names).toContain('ClawTeam');
    expect(names).not.toContain('broken');
  });
});
