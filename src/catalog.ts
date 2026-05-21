import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRootFromImportMeta } from "./project.js";

export type ProviderId = "copilot";
export type ProviderSupportState = "native" | "handoff" | "stub" | "unsupported";
export type CompatProviderState = "supported" | "fallback" | "unsupported";

export interface ProviderSupport {
  state: ProviderSupportState;
  notes: string;
}

export interface Capability {
  id: string;
  name: string;
  title: string;
  category: "clarification" | "planning" | "execution" | "tracking" | "verification" | string;
  summary: string;
  notes: string;
  defaultCommand: string;
  phase1: boolean;
  sourceSkill: string;
  providers: Record<ProviderId, CompatProviderState>;
  support: Record<ProviderId, string>;
  providerSupport: Record<ProviderId, ProviderSupport>;
}

export interface CapabilityCatalog {
  schemaVersion: number;
  providerStates: ProviderSupportState[];
  compatProviderStates?: CompatProviderState[];
  capabilities: Capability[];
}

export interface SkillProjection {
  name: string;
  capabilityId: string;
  capabilityIds: string[];
  source: string;
  sourcePath: string;
  canonicalPath: string;
  description: string;
  aliases: string[];
  slashCommands: string[];
  projections: Record<string, { command?: string; state?: CompatProviderState }>;
  summary: string;
  support: string;
  projection: "skill-wrapper" | "capability-handoff" | string;
  phase1: boolean;
  handoffOnly?: boolean;
}

export type SkillEntry = SkillProjection;

export interface SkillCatalog {
  schemaVersion: number;
  canonicalRoot: string;
  commandPrefix: string;
  skills: SkillProjection[];
}

export interface CatalogBundle {
  capabilities: CapabilityCatalog;
  skills: SkillCatalog;
}

export interface CatalogValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface CatalogValidationResult {
  ok: boolean;
  issues: CatalogValidationIssue[];
  capabilityIds: string[];
  skillNames: string[];
}

const REQUIRED_PHASE1_CAPABILITIES = [
  "grill",
  "ralplan",
  "team",
  "ralph",
  "jira-ticket",
  "code-review",
  "qa",
  "verify",
] as const;

const PROVIDERS: ProviderId[] = ["copilot"];
const STATES: ProviderSupportState[] = ["native", "handoff", "stub", "unsupported"];
const COMPAT_STATES: CompatProviderState[] = ["supported", "fallback", "unsupported"];

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function defaultCatalogDir(): string {
  return join(packageRootFromImportMeta(import.meta.url), "catalog");
}

export function loadCapabilityCatalog(catalogDir = defaultCatalogDir()): CapabilityCatalog {
  return readJsonFile<CapabilityCatalog>(join(catalogDir, "capabilities.json"));
}

export function loadSkillCatalog(catalogDir = defaultCatalogDir()): SkillCatalog {
  return readJsonFile<SkillCatalog>(join(catalogDir, "skills-general.json"));
}

export function loadCatalogBundle(catalogDir = defaultCatalogDir()): CatalogBundle {
  return {
    capabilities: loadCapabilityCatalog(catalogDir),
    skills: loadSkillCatalog(catalogDir),
  };
}

export function findCapability(id: string, catalog: CapabilityCatalog = loadCapabilityCatalog()): Capability | undefined {
  return catalog.capabilities.find((capability) => capability.id === id || capability.name === id);
}

export function validateCatalog(catalog: SkillCatalog = loadSkillCatalog()): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [index, skill] of catalog.skills.entries()) {
    if (!skill.name) errors.push(`skills[${index}] missing name`);
    if (names.has(skill.name)) errors.push(`duplicate skill name: ${skill.name}`);
    names.add(skill.name);
    if (!skill.source && !skill.sourcePath && !skill.canonicalPath) errors.push(`skill ${skill.name} missing source`);
    if (!skill.capabilityId && skill.capabilityIds.length === 0) errors.push(`skill ${skill.name} missing capability`);
    if (skill.slashCommands.length === 0) errors.push(`skill ${skill.name} missing slash command`);
  }
  return errors;
}

export function validateCatalogBundle(bundle: CatalogBundle = loadCatalogBundle()): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = [];
  const capabilityIds = bundle.capabilities.capabilities.map((capability) => capability.id);
  const skillNames = bundle.skills.skills.map((skill) => skill.name);
  const capabilityIdSet = new Set<string>();

  for (const state of bundle.capabilities.providerStates) {
    if (!STATES.includes(state)) {
      issues.push({ code: "unknown-provider-state", path: "capabilities.providerStates", message: `Unknown provider state: ${state}` });
    }
  }

  for (const [index, capability] of bundle.capabilities.capabilities.entries()) {
    const path = `capabilities[${index}]`;
    if (!capability.id) {
      issues.push({ code: "missing-capability-id", path, message: "Capability id is required." });
      continue;
    }
    if (capabilityIdSet.has(capability.id)) {
      issues.push({ code: "duplicate-capability-id", path: `${path}.id`, message: `Duplicate capability id: ${capability.id}` });
    }
    capabilityIdSet.add(capability.id);

    for (const provider of PROVIDERS) {
      const support = capability.providerSupport[provider];
      if (!support) {
        issues.push({ code: "missing-provider-support", path: `${path}.providerSupport.${provider}`, message: `Missing provider support for ${provider}.` });
        continue;
      }
      if (!STATES.includes(support.state)) {
        issues.push({ code: "invalid-provider-state", path: `${path}.providerSupport.${provider}.state`, message: `Invalid provider state: ${support.state}` });
      }
      const compatState = capability.providers[provider];
      if (compatState && !COMPAT_STATES.includes(compatState)) {
        issues.push({ code: "invalid-compat-provider-state", path: `${path}.providers.${provider}`, message: `Invalid compatibility provider state: ${compatState}` });
      }
    }
  }

  for (const requiredId of REQUIRED_PHASE1_CAPABILITIES) {
    if (!capabilityIdSet.has(requiredId)) {
      issues.push({ code: "missing-required-capability", path: "capabilities", message: `Missing Phase 1 capability: ${requiredId}` });
    }
  }

  for (const [index, skill] of bundle.skills.skills.entries()) {
    const path = `skills[${index}]`;
    if (!skill.name) {
      issues.push({ code: "missing-skill-name", path, message: "Skill name is required." });
    }
    const ids = new Set([skill.capabilityId, ...skill.capabilityIds]);
    for (const id of ids) {
      if (id && !capabilityIdSet.has(id)) {
        issues.push({ code: "unknown-skill-capability", path: `${path}.capabilityIds`, message: `Skill references unknown capability: ${id}` });
      }
    }
    if (skill.slashCommands.length === 0) {
      issues.push({ code: "missing-slash-command", path: `${path}.slashCommands`, message: `Skill ${skill.name} must expose at least one slash command.` });
    }
  }

  for (const error of validateCatalog(bundle.skills)) {
    issues.push({ code: "invalid-skill-catalog", path: "skills", message: error });
  }

  return { ok: issues.length === 0, issues, capabilityIds, skillNames };
}
