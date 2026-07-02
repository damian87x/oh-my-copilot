import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('discovers configuration from environment-compatible values', () => {
    const config = discoverJiraConfig('/tmp/no-such-root', {
      JIRA_SITE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'agent@example.com',
      JIRA_API_TOKEN: 'secret-token',
      JIRA_PROJECT_KEY: 'OMC',
    });

    expect(config.siteUrl).toBe('https://example.atlassian.net');
    expect(config.projectKey).toBe('OMC');
    expect(isJiraConfigured(config)).toBe(true);
  });

  it('renders create, comment, safe-update, and fallback payloads without live credentials', () => {
    const config = discoverJiraConfig('/tmp/no-such-root', { JIRA_PROJECT_KEY: 'OMC' });

    const create = createIssuePayload(config, { summary: 'Implement slice', description: 'Body' });
    expect(create.operation).toBe('create');
    expect(create.configured).toBe(false);
    expect(JSON.stringify(create.body)).toContain('Implement slice');

    expect(commentPayload(config, 'OMC-1', 'Evidence').operation).toBe('comment');
    expect(safeUpdatePayload(config, 'OMC-1', { summary: 'New' }).method).toBe('PUT');
    expect(transitionFallbackPayload(config, 'OMC-1', 'Done').configured).toBe(false);
    expect(linkFallbackPayload(config, 'OMC-1', 'OMC-2').operation).toBe('link-fallback');
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
    const result = await runCli(['jira', 'apply', 'OMC-1', '--link', '--dry-run', '--json']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/--link-target/);
  });

  it('rejects ambiguous create apply for a ticket key', async () => {
    const result = await runCli(['jira', 'apply', 'OMC-1', '--dry-run', '--json']);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/requires a readable plan\/ticket file/);
  });

  it('rejects non-HTTPS base URLs for live operations before fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const config = discoverJiraConfig('/tmp/no-such-root', {
      JIRA_MODE: 'live',
      JIRA_SITE_URL: 'http://example.atlassian.net',
      JIRA_EMAIL: 'agent@example.com',
      JIRA_API_TOKEN: 'secret-token',
      JIRA_PROJECT_KEY: 'OMC',
    });

    const result = await applyJiraOperation({
      operation: 'create',
      ticket: { summary: 'Unsafe URL', description: 'Body' },
    }, config);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.fallback)).toMatch(/https/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized live request payloads before fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const config = discoverJiraConfig('/tmp/no-such-root', {
      JIRA_MODE: 'live',
      JIRA_SITE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'agent@example.com',
      JIRA_API_TOKEN: 'secret-token',
      JIRA_PROJECT_KEY: 'OMC',
    });

    const result = await applyJiraOperation({
      operation: 'create',
      ticket: { summary: 'Huge payload', description: 'x'.repeat(70_000) },
    }, config);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.fallback)).toMatch(/payload/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

});
