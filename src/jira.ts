import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDotEnv } from './env/dotenv.js';

export type JiraMode = 'live' | 'dry-run';
export type JiraOperationName = 'create' | 'comment' | 'update' | 'transition' | 'link';

export interface JiraOperationsConfig {
  create?: boolean;
  update?: boolean;
  comment?: boolean;
  transition?: boolean | 'discover';
  link?: boolean | 'discover';
}

export interface JiraConfig {
  tracker: 'jira';
  mode: JiraMode;
  baseUrl?: string;
  /** Backcompat alias used by early scaffold tests. */
  siteUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey?: string;
  defaultIssueType: string;
  operations: Required<JiraOperationsConfig>;
  transitions: Record<string, string>;
  linkType?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  source: string[];
}

export interface JiraTicketInput {
  summary: string;
  description: string;
  issueType?: string;
  labels?: string[];
  components?: string[];
  priority?: string;
  acceptanceCriteria?: string[];
  implementationNotes?: string[];
}

export interface JiraRenderedIssue {
  operation: 'create';
  endpoint: string;
  payload: {
    fields: Record<string, unknown>;
  };
}

export interface JiraFallback {
  operation: JiraOperationName;
  reason: string;
  target: string;
  payload: unknown;
  humanAction: string;
}

export interface JiraApplyOptions {
  operation: JiraOperationName;
  target?: string;
  ticket?: JiraTicketInput;
  comment?: string;
  update?: Partial<JiraTicketInput>;
  transitionState?: string;
  linkTarget?: string;
  dryRun?: boolean;
}

export interface JiraResult {
  ok: boolean;
  live: boolean;
  operation: JiraOperationName;
  response?: unknown;
  fallback?: JiraFallback;
}

const DEFAULT_TRANSITIONS: Record<string, string> = {
  planned: 'To Do',
  in_progress: 'In Progress',
  review: 'In Review',
  qa: 'QA',
  done: 'Done',
  blocked: 'Blocked',
};

const DEFAULT_OPERATIONS: Required<JiraOperationsConfig> = {
  create: true,
  update: true,
  comment: true,
  transition: 'discover',
  link: 'discover',
};

const SAFE_UPDATE_FIELDS = new Set(['summary', 'description', 'labels', 'components', 'priority']);

export function loadDotEnv(cwd = process.cwd()): Record<string, string> {
  const path = join(cwd, '.env');
  if (!existsSync(path)) return {};
  return parseDotEnv(readFileSync(path, 'utf8'));
}

export function discoverJiraConfig(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<JiraConfig>;
  configPath?: string;
} | string = {}, envArg?: NodeJS.ProcessEnv): JiraConfig {
  const normalized = typeof options === 'string' ? { cwd: options, env: envArg } : options;
  const cwd = normalized.cwd ?? process.cwd();
  const processEnv = normalized.env ?? process.env;
  const dotEnv = loadDotEnv(cwd);
  const mergedEnv = { ...dotEnv, ...processEnv };
  const external = readExternalConfig(cwd, mergedEnv, normalized.configPath);
  const jira = normalizeExternalJira(external.config);
  const source = [...external.source];

  const config: JiraConfig = {
    tracker: 'jira',
    mode: normalizeMode(jira.mode ?? mergedEnv.JIRA_MODE ?? 'dry-run'),
    baseUrl: resolveEnvRef(jira.baseUrl ?? jira.siteUrl, mergedEnv) ?? mergedEnv.JIRA_BASE_URL ?? mergedEnv.JIRA_SITE_URL,
    email: resolveEnvRef(jira.email ?? jira.user, mergedEnv) ?? mergedEnv.JIRA_EMAIL ?? mergedEnv.JIRA_USER,
    apiToken: resolveEnvRef(jira.apiToken ?? jira.auth ?? jira.token, mergedEnv) ?? mergedEnv.JIRA_API_TOKEN ?? mergedEnv.JIRA_TOKEN,
    projectKey: resolveEnvRef(jira.projectKey ?? jira.project, mergedEnv) ?? mergedEnv.JIRA_PROJECT_KEY,
    defaultIssueType: String(jira.defaultIssueType ?? mergedEnv.JIRA_DEFAULT_ISSUE_TYPE ?? 'Task'),
    operations: { ...DEFAULT_OPERATIONS, ...(jira.operations ?? {}) },
    transitions: { ...DEFAULT_TRANSITIONS, ...(jira.transitions ?? {}) },
    linkType: resolveEnvRef(jira.linkType, mergedEnv) ?? mergedEnv.JIRA_LINK_TYPE,
    labels: normalizeList(jira.labels ?? mergedEnv.JIRA_LABELS),
    components: normalizeList(jira.components ?? mergedEnv.JIRA_COMPONENTS),
    priority: resolveEnvRef(jira.priority, mergedEnv) ?? mergedEnv.JIRA_PRIORITY,
    source,
  };

  config.siteUrl = config.baseUrl;

  const overrides = normalized.overrides ?? {};
  return {
    ...config,
    ...overrides,
    operations: { ...config.operations, ...(overrides.operations ?? {}) },
    transitions: { ...config.transitions, ...(overrides.transitions ?? {}) },
    siteUrl: overrides.siteUrl ?? overrides.baseUrl ?? config.siteUrl,
    source: [...config.source, ...(overrides.source ?? [])],
  };
}

function readExternalConfig(cwd: string, env: NodeJS.ProcessEnv, explicitPath?: string): { config: Record<string, unknown>; source: string[] } {
  const candidates = [
    explicitPath,
    env.OH_MY_COPILOT_JIRA_CONFIG,
    env.JIRA_CONFIG_FILE,
    join(homedir(), '.config', 'oh-my-copilot', 'jira.json'),
    join(homedir(), '.config', 'oh-my-copilot', 'config.json'),
    join(homedir(), '.oh-my-copilot', 'jira.json'),
    join(cwd, '.oh-my-copilot.jira.json'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return { config: parsed, source: [path] };
  }

  return { config: {}, source: ['env/.env'] };
}

function normalizeExternalJira(raw: Record<string, unknown>): Record<string, any> {
  if (raw.jira && typeof raw.jira === 'object') return raw.jira as Record<string, any>;
  return raw as Record<string, any>;
}

function normalizeMode(value: unknown): JiraMode {
  return value === 'live' ? 'live' : 'dry-run';
}

function resolveEnvRef(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('env:')) return value;
  return env[value.slice('env:'.length)];
}

function normalizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

export function ticketFromMarkdown(markdown: string, fallbackSummary = 'Planned work'): JiraTicketInput {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim();
  const firstText = lines.find((line) => line.trim() && !line.trim().startsWith('#'))?.trim();
  const acceptanceCriteria = extractListSection(lines, /acceptance criteria/i);
  const implementationNotes = extractListSection(lines, /implementation notes|notes/i);
  return {
    summary: heading || firstText || fallbackSummary,
    description: markdown.trim() || fallbackSummary,
    acceptanceCriteria,
    implementationNotes,
  };
}

function extractListSection(lines: string[], headerPattern: RegExp): string[] | undefined {
  const start = lines.findIndex((line) => headerPattern.test(line));
  if (start === -1) return undefined;
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line) && items.length) break;
    const match = line.match(/^\s*[-*]\s+(.*)$/);
    if (match) items.push(match[1].trim());
  }
  return items.length ? items : undefined;
}

export function readTicketInput(path: string): JiraTicketInput {
  const text = readFileSync(path, 'utf8');
  if (/\.json$/i.test(path)) return JSON.parse(text) as JiraTicketInput;
  return ticketFromMarkdown(text, `Jira ticket from ${path}`);
}

export function renderCreateIssue(ticket: JiraTicketInput, config: JiraConfig = discoverJiraConfig()): JiraRenderedIssue {
  const projectKey = config.projectKey ?? '<PROJECT-KEY>';
  const fields: Record<string, unknown> = {
    project: { key: projectKey },
    issuetype: { name: ticket.issueType ?? config.defaultIssueType },
    summary: ticket.summary,
    description: composeDescription(ticket),
  };

  const labels = [...(config.labels ?? []), ...(ticket.labels ?? [])];
  if (labels.length) fields.labels = unique(labels);

  const components = ticket.components ?? config.components;
  if (components?.length) fields.components = components.map((name) => ({ name }));

  const priority = ticket.priority ?? config.priority;
  if (priority) fields.priority = { name: priority };

  return {
    operation: 'create',
    endpoint: '/rest/api/3/issue',
    payload: { fields },
  };
}

export function renderComment(comment: string): { body: string } {
  return { body: comment };
}

export function renderSafeUpdate(update: Partial<JiraTicketInput>, config: JiraConfig = discoverJiraConfig()): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  if (update.summary) fields.summary = update.summary;
  if (update.description || update.acceptanceCriteria || update.implementationNotes) {
    fields.description = composeDescription({
      summary: update.summary ?? 'Update',
      description: update.description ?? '',
      acceptanceCriteria: update.acceptanceCriteria,
      implementationNotes: update.implementationNotes,
    });
  }
  const labels = update.labels;
  if (labels) fields.labels = unique([...(config.labels ?? []), ...labels]);
  const components = update.components;
  if (components) fields.components = components.map((name) => ({ name }));
  const priority = update.priority;
  if (priority) fields.priority = { name: priority };

  for (const key of Object.keys(fields)) {
    if (!SAFE_UPDATE_FIELDS.has(key)) delete fields[key];
  }
  return { fields };
}

function composeDescription(ticket: JiraTicketInput): string {
  const sections = [ticket.description.trim()];
  if (ticket.acceptanceCriteria?.length) {
    sections.push(['Acceptance Criteria', ...ticket.acceptanceCriteria.map((item) => `- ${item}`)].join('\n'));
  }
  if (ticket.implementationNotes?.length) {
    sections.push(['Implementation Notes', ...ticket.implementationNotes.map((item) => `- ${item}`)].join('\n'));
  }
  return sections.filter(Boolean).join('\n\n');
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function fallbackMarkdown(fallback: JiraFallback): string {
  return [
    `## Jira fallback: ${fallback.operation}`,
    `Reason: ${fallback.reason}`,
    `Target: ${fallback.target}`,
    'Payload:',
    '```json',
    JSON.stringify(fallback.payload, null, 2),
    '```',
    'Human action:',
    fallback.humanAction,
  ].join('\n');
}

export function makeFallback(operation: JiraOperationName, reason: string, target: string, payload: unknown): JiraFallback {
  const action = humanActionFor(operation, target);
  return { operation, reason, target, payload, humanAction: action };
}

function humanActionFor(operation: JiraOperationName, target: string): string {
  switch (operation) {
    case 'create':
      return 'Create a Jira issue with the payload above.';
    case 'comment':
      return `Add the comment payload above to ${target}.`;
    case 'update':
      return `Update only the safe fields shown above on ${target}.`;
    case 'transition':
      return `Choose the matching Jira workflow transition for ${target}; do not guess an id.`;
    case 'link':
      return `Create the Jira issue link for ${target} only after confirming the link type exists.`;
  }
}

export function canRunLive(config: JiraConfig, operation: JiraOperationName): boolean {
  if (config.mode !== 'live') return false;
  if (!config.baseUrl || !config.email || !config.apiToken) return false;
  if (operation === 'create' && !config.projectKey) return false;
  const configured = config.operations[operation];
  return configured === true || configured === 'discover';
}

export class JiraRestClient {
  constructor(private readonly config: JiraConfig) {}

  async createIssue(ticket: JiraTicketInput): Promise<unknown> {
    return this.request('/rest/api/3/issue', { method: 'POST', body: renderCreateIssue(ticket, this.config).payload });
  }

  async addComment(ticketKey: string, comment: string): Promise<unknown> {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`, { method: 'POST', body: renderComment(comment) });
  }

  async safeUpdate(ticketKey: string, update: Partial<JiraTicketInput>): Promise<unknown> {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(ticketKey)}`, { method: 'PUT', body: renderSafeUpdate(update, this.config) });
  }

  async listTransitions(ticketKey: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request(`/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`, { method: 'GET' }) as { transitions?: Array<{ id: string; name: string }> };
    return response.transitions ?? [];
  }

  async transitionIssue(ticketKey: string, transitionId: string): Promise<unknown> {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(ticketKey)}/transitions`, {
      method: 'POST',
      body: { transition: { id: transitionId } },
    });
  }

  async listIssueLinkTypes(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request('/rest/api/3/issueLinkType', { method: 'GET' }) as { issueLinkTypes?: Array<{ id: string; name: string }> };
    return response.issueLinkTypes ?? [];
  }

  async linkIssues(inwardIssue: string, outwardIssue: string, typeName: string): Promise<unknown> {
    return this.request('/rest/api/3/issueLink', {
      method: 'POST',
      body: { type: { name: typeName }, inwardIssue: { key: inwardIssue }, outwardIssue: { key: outwardIssue } },
    });
  }

  private async request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    if (!this.config.baseUrl || !this.config.email || !this.config.apiToken) {
      throw new Error('Jira config is incomplete');
    }
    const response = await fetch(new URL(path, this.config.baseUrl), {
      method: init.method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64')}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new Error(`Jira ${init.method} ${path} failed: ${response.status} ${text}`);
    return data;
  }
}

export async function applyJiraOperation(options: JiraApplyOptions, config: JiraConfig = discoverJiraConfig()): Promise<JiraResult> {
  const dryRun = options.dryRun || !canRunLive(config, options.operation);
  const target = options.target ?? 'new issue';
  const payload = payloadForOperation(options, config);
  if (dryRun) {
    return {
      ok: true,
      live: false,
      operation: options.operation,
      fallback: makeFallback(options.operation, fallbackReason(config, options.operation, options.dryRun), target, payload),
    };
  }

  const client = new JiraRestClient(config);
  try {
    if (options.operation === 'create') {
      return { ok: true, live: true, operation: 'create', response: await client.createIssue(requireTicket(options.ticket)) };
    }
    if (options.operation === 'comment') {
      return { ok: true, live: true, operation: 'comment', response: await client.addComment(requireTarget(options.target), options.comment ?? '') };
    }
    if (options.operation === 'update') {
      return { ok: true, live: true, operation: 'update', response: await client.safeUpdate(requireTarget(options.target), options.update ?? options.ticket ?? {}) };
    }
    if (options.operation === 'transition') {
      const transition = await resolveDiscoveredTransition(client, requireTarget(options.target), options.transitionState ?? 'done', config);
      if (!transition) throw new DiscoveryRequiredError('No exact configured/discovered Jira transition matched');
      return { ok: true, live: true, operation: 'transition', response: await client.transitionIssue(requireTarget(options.target), transition.id) };
    }
    if (options.operation === 'link') {
      const linkType = await resolveDiscoveredLinkType(client, config);
      if (!linkType) throw new DiscoveryRequiredError('No configured Jira link type was discovered');
      return { ok: true, live: true, operation: 'link', response: await client.linkIssues(requireTarget(options.target), requireTarget(options.linkTarget), linkType.name) };
    }
  } catch (error) {
    return {
      ok: false,
      live: false,
      operation: options.operation,
      fallback: makeFallback(options.operation, error instanceof Error ? error.message : String(error), target, payload),
    };
  }

  return {
    ok: false,
    live: false,
    operation: options.operation,
    fallback: makeFallback(options.operation, `Unsupported Jira operation: ${options.operation}`, target, payload),
  };
}

function payloadForOperation(options: JiraApplyOptions, config: JiraConfig): unknown {
  switch (options.operation) {
    case 'create': return renderCreateIssue(requireTicket(options.ticket), config).payload;
    case 'comment': return renderComment(options.comment ?? '');
    case 'update': return renderSafeUpdate(options.update ?? options.ticket ?? {}, config);
    case 'transition': return { transition: { logicalState: options.transitionState ?? 'done', configuredName: config.transitions[options.transitionState ?? 'done'] } };
    case 'link': return { type: { name: config.linkType ?? '<discover>' }, inwardIssue: { key: options.target }, outwardIssue: { key: options.linkTarget } };
  }
}

function fallbackReason(config: JiraConfig, operation: JiraOperationName, explicitDryRun?: boolean): string {
  if (explicitDryRun) return 'dry-run requested; no live Jira write was attempted';
  if (config.mode !== 'live') return 'Jira mode is dry-run; no live Jira write was attempted';
  if (!config.baseUrl || !config.email || !config.apiToken) return 'Jira credentials/config are incomplete';
  if (operation === 'create' && !config.projectKey) return 'Jira project key is missing; live create was not attempted';
  if (!config.operations[operation]) return `Jira ${operation} operation is disabled in config`;
  return `Jira ${operation} requires discovery or live execution was not available`;
}

async function resolveDiscoveredTransition(client: JiraRestClient, ticketKey: string, logicalState: string, config: JiraConfig): Promise<{ id: string; name: string } | undefined> {
  const wanted = config.transitions[logicalState] ?? logicalState;
  const transitions = await client.listTransitions(ticketKey);
  return transitions.find((transition) => transition.name === wanted || transition.id === wanted);
}

async function resolveDiscoveredLinkType(client: JiraRestClient, config: JiraConfig): Promise<{ id: string; name: string } | undefined> {
  if (!config.linkType) return undefined;
  const linkTypes = await client.listIssueLinkTypes();
  return linkTypes.find((type) => type.name === config.linkType || type.id === config.linkType);
}

class DiscoveryRequiredError extends Error {}

function requireTicket(ticket: JiraTicketInput | undefined): JiraTicketInput {
  if (!ticket) throw new Error('Jira ticket input is required');
  return ticket;
}

function requireTarget(target: string | undefined): string {
  if (!target) throw new Error('Jira ticket key/target is required');
  return target;
}

export function configSummary(config: JiraConfig): Record<string, unknown> {
  return {
    tracker: config.tracker,
    mode: config.mode,
    baseUrlConfigured: Boolean(config.baseUrl),
    emailConfigured: Boolean(config.email),
    tokenConfigured: Boolean(config.apiToken),
    projectKey: config.projectKey,
    defaultIssueType: config.defaultIssueType,
    operations: config.operations,
    source: config.source,
  };
}

export function formatJiraDryRun(config: JiraConfig = discoverJiraConfig()): string {
  const sampleTicket: JiraTicketInput = {
    issueType: config.defaultIssueType,
    summary: 'Dry-run Jira issue',
    description: 'Generated by oh-my-copilot jira:dry-run.',
    labels: ['oh-my-copilot', 'dry-run'],
  };
  const create = createIssuePayload(config, sampleTicket);
  const comment = commentPayload(config, 'OMP-123', 'Verification: dry-run evidence collected.');
  const update = safeUpdatePayload(config, 'OMP-123', { summary: 'Dry-run Jira issue update', labels: ['verified'] });
  const transition = transitionFallbackPayload(config, 'OMP-123', 'Done');
  const link = linkFallbackPayload(config, 'OMP-123', 'OMP-124');

  return JSON.stringify({
    ok: true,
    dryRun: true,
    jira: configSummary(config),
    operations: { create, comment, update, transition, link },
  }, null, 2);
}

export function inferProjectRoot(fromPath: string): string {
  return dirname(resolve(fromPath));
}


/** Backcompat helper for the initial package tests and thin CLI wrappers. */
export function isJiraConfigured(config: JiraConfig): boolean {
  return Boolean((config.baseUrl ?? config.siteUrl) && config.email && config.apiToken && config.projectKey);
}

/** Backcompat payload shape: REST method/endpoint/body plus configured flag. */
export function createIssuePayload(config: JiraConfig, ticket: JiraTicketInput): {
  operation: 'create';
  configured: boolean;
  method: 'POST';
  endpoint: string;
  body: JiraRenderedIssue['payload'];
} {
  const rendered = renderCreateIssue(ticket, config);
  return {
    operation: 'create',
    configured: isJiraConfigured(config),
    method: 'POST',
    endpoint: rendered.endpoint,
    body: rendered.payload,
  };
}

export function commentPayload(config: JiraConfig, ticketKey: string, comment: string): {
  operation: 'comment';
  configured: boolean;
  method: 'POST';
  endpoint: string;
  body: { body: string };
} {
  return {
    operation: 'comment',
    configured: isJiraConfigured(config),
    method: 'POST',
    endpoint: `/rest/api/3/issue/${encodeURIComponent(ticketKey)}/comment`,
    body: renderComment(comment),
  };
}

export function safeUpdatePayload(config: JiraConfig, ticketKey: string, update: Partial<JiraTicketInput>): {
  operation: 'update';
  configured: boolean;
  method: 'PUT';
  endpoint: string;
  body: { fields: Record<string, unknown> };
} {
  return {
    operation: 'update',
    configured: isJiraConfigured(config),
    method: 'PUT',
    endpoint: `/rest/api/3/issue/${encodeURIComponent(ticketKey)}`,
    body: renderSafeUpdate(update, config),
  };
}

export function transitionFallbackPayload(config: JiraConfig, ticketKey: string, logicalState: string): {
  operation: 'transition-fallback';
  configured: false;
  target: string;
  body: JiraFallback;
} {
  const payload = { transition: { logicalState, configuredName: config.transitions[logicalState] ?? logicalState } };
  return {
    operation: 'transition-fallback',
    configured: false,
    target: ticketKey,
    body: makeFallback('transition', 'transition requires Jira discovery; no transition id was guessed', ticketKey, payload),
  };
}

export function linkFallbackPayload(config: JiraConfig, inwardIssue: string, outwardIssue: string): {
  operation: 'link-fallback';
  configured: false;
  target: string;
  body: JiraFallback;
} {
  const payload = { type: { name: config.linkType ?? '<discover>' }, inwardIssue: { key: inwardIssue }, outwardIssue: { key: outwardIssue } };
  return {
    operation: 'link-fallback',
    configured: false,
    target: `${inwardIssue} -> ${outwardIssue}`,
    body: makeFallback('link', 'link requires Jira link type discovery; no link type was guessed', `${inwardIssue} -> ${outwardIssue}`, payload),
  };
}
