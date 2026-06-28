import { describe, expect, it } from 'vitest';
import {
  applyJiraOperation,
  canRunLive,
  commentPayload,
  createIssuePayload,
  discoverJiraConfig,
  isJiraConfigured,
  linkFallbackPayload,
  safeUpdatePayload,
  transitionFallbackPayload,
} from '../src/jira.js';
import { runCli } from '../src/cli.js';

describe('Jira adapter payloads', () => {
  it('discovers configuration from environment-compatible values', () => {
    const config = discoverJiraConfig('/tmp/no-such-root', {
      JIRA_SITE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'agent@example.com',
      JIRA_API_TOKEN: 'secret-token',
      JIRA_PROJECT_KEY: 'OMP',
    });

    expect(config.siteUrl).toBe('https://example.atlassian.net');
    expect(config.projectKey).toBe('OMP');
    expect(isJiraConfigured(config)).toBe(true);
  });

  it('renders create, comment, safe-update, and fallback payloads without live credentials', () => {
    const config = discoverJiraConfig('/tmp/no-such-root', { JIRA_PROJECT_KEY: 'OMP' });

    const create = createIssuePayload(config, { summary: 'Implement slice', description: 'Body' });
    expect(create.operation).toBe('create');
    expect(create.configured).toBe(false);
    expect(JSON.stringify(create.body)).toContain('Implement slice');

    expect(commentPayload(config, 'OMP-1', 'Evidence').operation).toBe('comment');
    expect(safeUpdatePayload(config, 'OMP-1', { summary: 'New' }).method).toBe('PUT');
    expect(transitionFallbackPayload(config, 'OMP-1', 'Done').configured).toBe(false);
    expect(linkFallbackPayload(config, 'OMP-1', 'OMP-2').operation).toBe('link-fallback');
  });

  it('does not allow live create without an explicit Jira project key', async () => {
    const config = discoverJiraConfig('/tmp/no-such-root', {
      JIRA_MODE: 'live',
      JIRA_SITE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'agent@example.com',
      JIRA_API_TOKEN: 'secret-token',
    });

    expect(canRunLive(config, 'create')).toBe(false);
    const result = await applyJiraOperation({
      operation: 'create',
      ticket: { summary: 'No guessed project', description: 'Body' },
    }, config);

    expect(result.live).toBe(false);
    expect(result.fallback?.reason).toMatch(/project key is missing/i);
    expect(JSON.stringify(result.fallback?.payload)).toContain('<PROJECT-KEY>');
  });

  it('rejects link apply without a link target', async () => {
    const result = await runCli(['jira', 'apply', 'OMP-1', '--link', '--dry-run', '--json']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--link-target/);
  });

  it('rejects ambiguous create apply for a ticket key', async () => {
    const result = await runCli(['jira', 'apply', 'OMP-1', '--dry-run', '--json']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/requires a readable plan\/ticket file/);
  });

});
