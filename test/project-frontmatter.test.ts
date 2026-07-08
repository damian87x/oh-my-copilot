import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/project.js';

describe('parseFrontmatter', () => {
  it('parses a plain frontmatter block', () => {
    const fm = parseFrontmatter('---\nname: forecasting\ndescription: Do a thing.\n---\n\n# Body\n');
    expect(fm.name).toBe('forecasting');
    expect(fm.description).toBe('Do a thing.');
  });

  it('parses frontmatter preceded by an HTML/license comment (Anthropic skills)', () => {
    const text =
      '<!-- Copyright 2026 Anthropic PBC -->\n' +
      '<!-- SPDX-License-Identifier: Apache-2.0 -->\n' +
      '\n' +
      '---\n' +
      'name: eval-audit-and-sweep\n' +
      'description: Audit and sweep an eval.\n' +
      '---\n\n# Body\n';
    const fm = parseFrontmatter(text);
    expect(fm.name).toBe('eval-audit-and-sweep');
    expect(fm.description).toBe('Audit and sweep an eval.');
  });

  it('parses frontmatter preceded by blank lines', () => {
    const fm = parseFrontmatter('\n\n---\nname: mining\ndescription: Where diamonds spawn.\n---\n');
    expect(fm.name).toBe('mining');
  });

  it('returns empty for a file with no frontmatter', () => {
    expect(parseFrontmatter('# Just markdown\n\nno frontmatter here')).toEqual({});
  });

  it('still parses when a comment follows the frontmatter block', () => {
    // agent-decomposition-style: comment after the closing --- is body, ignored.
    const fm = parseFrontmatter('---\nname: weekly-report\ndescription: A report.\n---\n<!-- Copyright -->\n# Body\n');
    expect(fm.name).toBe('weekly-report');
    expect(fm.description).toBe('A report.');
  });
});
