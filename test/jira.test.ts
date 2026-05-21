import { describe, expect, it } from 'vitest';
import {
  commentPayload,
  createIssuePayload,
  discoverJiraConfig,
  isJiraConfigured,
  linkFallbackPayload,
  safeUpdatePayload,
  transitionFallbackPayload,
} from '../src/jira.js';

describe('Jira adapter payloads', () => {
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
});
