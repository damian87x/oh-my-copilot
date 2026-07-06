import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('keeps file-backed apply on the local fallback path even with live config', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const dir = mkdtempSync(join(tmpdir(), 'omc-jira-'));
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, '# File sourced issue\n\nDo not send this directly to Jira.', 'utf8');
    const previous = {
      JIRA_MODE: process.env.JIRA_MODE,
      JIRA_SITE_URL: process.env.JIRA_SITE_URL,
      JIRA_EMAIL: process.env.JIRA_EMAIL,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
      JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY,
    };
    try {
      process.env.JIRA_MODE = 'live';
      process.env.JIRA_SITE_URL = 'https://example.atlassian.net';
      process.env.JIRA_EMAIL = 'agent@example.com';
      process.env.JIRA_API_TOKEN = 'secret-token';
      process.env.JIRA_PROJECT_KEY = 'OMC';

      const result = await runCli(['jira', 'apply', planPath, '--json']);

      expect(result.ok).toBe(true);
      expect(result.output.live).toBe(false);
      expect(result.output.fallback.reason).toMatch(/file-backed Jira apply is dry-run only/i);
      expect(JSON.stringify(result.output.fallback.payload)).toContain('File sourced issue');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
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
