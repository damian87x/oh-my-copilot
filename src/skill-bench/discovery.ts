import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type SkillSourceKind = "project" | "user" | "plugin" | "explicit";

export interface DiscoveredSkillBenchSkill {
  id: string;
  name: string;
  description: string;
  canonicalPath: string;
  skillFilePath: string;
  sourceUri: string;
  sourceKind: SkillSourceKind;
  fingerprint: string;
  provenance: {
    rootKind: SkillSourceKind;
    rootPath: string;
    discoveredFrom: string;
  };
}

export interface RejectedSkillBenchSkill {
  path: string;
  reason: string;
}

export interface DiscoverSkillBenchSkillsOptions {
  projectRoots?: string[];
  userRoots?: string[];
  pluginRoots?: string[];
  explicitPaths?: string[];
}

export interface DiscoverSkillBenchSkillsResult {
  skills: DiscoveredSkillBenchSkill[];
  rejected: RejectedSkillBenchSkill[];
}

export type ModelCandidateSource = "history" | "configured" | "host-default" | "explicit" | "provider-snapshot";
export type ModelProbeStatus = "available" | "unavailable" | "unknown";

export interface ProviderModelSnapshot {
  url: string;
  date: string;
  modelIds: string[];
}

export interface ModelCandidate {
  id: string;
  sources: ModelCandidateSource[];
  probeStatus: ModelProbeStatus;
  selectable: boolean;
  unavailableReason?: string;
}

export interface ResolveModelCandidatesOptions {
  historyObservedIds?: string[];
  configuredIds?: string[];
  hostDefaultIds?: string[];
  explicitIds?: string[];
  providerSnapshots?: ProviderModelSnapshot[];
  probe?: (id: string) => Promise<{ status: ModelProbeStatus | "timeout"; reason?: string }>;
}

export interface ResolveModelCandidatesResult {
  candidates: ModelCandidate[];
  completeEnumeration: false;
  enumerationProvenance: string[];
}

interface CandidateRecord {
  id: string;
  sources: Set<ModelCandidateSource>;
}

const SOURCE_ORDER: ModelCandidateSource[] = ["history", "configured", "host-default", "explicit", "provider-snapshot"];

export function discoverSkillBenchSkills(options: DiscoverSkillBenchSkillsOptions): DiscoverSkillBenchSkillsResult {
  const rejected: RejectedSkillBenchSkill[] = [];
  const candidates: Array<{ skillFile: string; skillDir: string; sourceKind: SkillSourceKind; rootPath: string; discoveredFrom: string; explicit: boolean }> = [];

  collectRootSkills(candidates, rejected, options.projectRoots ?? [], "project");
  collectRootSkills(candidates, rejected, options.userRoots ?? [], "user");
  collectRootSkills(candidates, rejected, options.pluginRoots ?? [], "plugin");

  for (const explicitPath of options.explicitPaths ?? []) {
    const resolved = resolveExplicitSkillPath(explicitPath, rejected);
    if (resolved) candidates.push({ ...resolved, sourceKind: "explicit", rootPath: resolved.skillDir, discoveredFrom: explicitPath, explicit: true });
  }

  const skills: DiscoveredSkillBenchSkill[] = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    try {
      const metadata = parseSkillFrontmatter(candidate.skillFile);
      if (!metadata.description.trim()) {
        rejected.push({ path: candidate.skillFile, reason: "missing description" });
        continue;
      }
      const canonicalPath = realpathSync(candidate.skillDir);
      const fingerprint = fingerprintDirectory(canonicalPath);
      const id = `${slug(metadata.name)}-${createHash("sha256").update(`${canonicalPath}#${candidateIndex}`).digest("hex").slice(0, 12)}`;
      skills.push({
        id,
        name: metadata.name,
        description: metadata.description,
        canonicalPath,
        skillFilePath: realpathSync(candidate.skillFile),
        sourceUri: pathToFileUri(realpathSync(candidate.skillFile)),
        sourceKind: candidate.sourceKind,
        fingerprint,
        provenance: {
          rootKind: candidate.sourceKind,
          rootPath: candidate.explicit ? canonicalPath : realpathSync(candidate.rootPath),
          discoveredFrom: candidate.discoveredFrom,
        },
      });
    } catch (error) {
      rejected.push({ path: candidate.skillFile, reason: error instanceof Error ? error.message : "unreadable skill" });
    }
  }

  return { skills, rejected };
}

function collectRootSkills(
  candidates: Array<{ skillFile: string; skillDir: string; sourceKind: SkillSourceKind; rootPath: string; discoveredFrom: string; explicit: boolean }>,
  rejected: RejectedSkillBenchSkill[],
  roots: string[],
  sourceKind: Exclude<SkillSourceKind, "explicit">,
): void {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let rootReal: string;
    try {
      if (lstatSync(root).isSymbolicLink()) {
        rejected.push({ path: root, reason: "symlink root blocked" });
        continue;
      }
      rootReal = realpathSync(root);
    } catch (error) {
      rejected.push({ path: root, reason: error instanceof Error ? error.message : "unreadable root" });
      continue;
    }
    const entries = safeReadDir(root, rejected);
    for (const entry of entries) {
      const entryPath = path.join(root, entry);
      try {
        if (lstatSync(entryPath).isSymbolicLink()) {
          const real = realpathSync(entryPath);
          if (escapesRoot(rootReal, real)) {
            rejected.push({ path: entryPath, reason: "symlink escape blocked" });
            continue;
          }
        }
        if (!statSync(entryPath).isDirectory()) continue;
        const skillFile = path.join(entryPath, "SKILL.md");
        if (!existsSync(skillFile)) continue;
        const realSkillDir = realpathSync(entryPath);
        if (escapesRoot(rootReal, realSkillDir)) {
          rejected.push({ path: entryPath, reason: "symlink escape blocked" });
          continue;
        }
        candidates.push({ skillFile, skillDir: entryPath, sourceKind, rootPath: root, discoveredFrom: root, explicit: false });
      } catch (error) {
        rejected.push({ path: entryPath, reason: error instanceof Error ? error.message : "unreadable skill" });
      }
    }
  }
}

function resolveExplicitSkillPath(explicitPath: string, rejected: RejectedSkillBenchSkill[]): { skillFile: string; skillDir: string } | null {
  try {
    if (!existsSync(explicitPath)) {
      rejected.push({ path: explicitPath, reason: "explicit skill path does not exist" });
      return null;
    }
    const stats = statSync(explicitPath);
    if (stats.isDirectory()) {
      const skillFile = path.join(explicitPath, "SKILL.md");
      if (!existsSync(skillFile)) {
        rejected.push({ path: explicitPath, reason: "explicit skill directory missing SKILL.md" });
        return null;
      }
      return { skillFile, skillDir: explicitPath };
    }
    if (stats.isFile() && path.basename(explicitPath) === "SKILL.md") return { skillFile: explicitPath, skillDir: path.dirname(explicitPath) };
    rejected.push({ path: explicitPath, reason: "explicit skill path must be a skill directory or SKILL.md" });
    return null;
  } catch (error) {
    rejected.push({ path: explicitPath, reason: error instanceof Error ? error.message : "unreadable explicit skill" });
    return null;
  }
}

function safeReadDir(root: string, rejected: RejectedSkillBenchSkill[]): string[] {
  try {
    return readdirSync(root).sort();
  } catch (error) {
    rejected.push({ path: root, reason: error instanceof Error ? error.message : "unreadable root" });
    return [];
  }
}

function parseSkillFrontmatter(skillFile: string): { name: string; description: string } {
  const text = readFileSync(skillFile, "utf8");
  if (!text.startsWith("---\n")) throw new Error("invalid frontmatter");
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error("invalid frontmatter");
  const frontmatter = text.slice(4, end).split(/\r?\n/);
  const values: Record<string, string> = {};
  for (const rawLine of frontmatter) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
    if (!match) throw new Error("invalid frontmatter");
    const value = match[2].trim();
    if (/^[{[]/.test(value) || /[\]{}[]/.test(value)) throw new Error("invalid frontmatter");
    values[match[1]] = stripQuotes(value);
  }
  if (!values.name) throw new Error("missing name");
  if (!("description" in values) || !values.description.trim()) throw new Error("missing description");
  return { name: values.name, description: values.description };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function fingerprintDirectory(directory: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(directory)) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    hash.update(relative).update("\0").update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

function listFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const entryPath = path.join(directory, entry);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) out.push(...listFiles(entryPath));
    else if (stats.isFile()) out.push(entryPath);
  }
  return out;
}

function escapesRoot(rootReal: string, targetReal: string): boolean {
  const relative = path.relative(rootReal, targetReal);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function pathToFileUri(filePath: string): string {
  return new URL(`file://${path.resolve(filePath)}`).href;
}

export async function resolveModelCandidates(options: ResolveModelCandidatesOptions): Promise<ResolveModelCandidatesResult> {
  const candidates = new Map<string, CandidateRecord>();
  const add = (id: string, source: ModelCandidateSource): void => {
    if (!id.trim()) return;
    const existing = candidates.get(id) ?? { id, sources: new Set<ModelCandidateSource>() };
    existing.sources.add(source);
    candidates.set(id, existing);
  };

  for (const id of options.historyObservedIds ?? []) add(id, "history");
  for (const id of options.configuredIds ?? []) add(id, "configured");
  for (const id of options.hostDefaultIds ?? []) add(id, "host-default");
  for (const id of options.explicitIds ?? []) add(id, "explicit");
  for (const snapshot of options.providerSnapshots ?? []) for (const id of snapshot.modelIds) add(id, "provider-snapshot");

  const resolved: ModelCandidate[] = [];
  for (const record of candidates.values()) {
    const probe = options.probe ? await options.probe(record.id) : { status: "unknown" as const };
    const probeStatus: ModelProbeStatus = probe.status === "timeout" ? "unknown" : probe.status;
    resolved.push({
      id: record.id,
      sources: [...record.sources].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b)),
      probeStatus,
      selectable: probeStatus !== "unavailable",
      unavailableReason: probeStatus === "unavailable" ? probe.reason : undefined,
    });
  }

  return {
    candidates: resolved,
    completeEnumeration: false,
    enumerationProvenance: [
      "history observed model ids",
      "configured model ids",
      "host default/auto ids",
      "explicit user-entered ids",
      ...(options.providerSnapshots ?? []).map((snapshot) => `provider snapshot ${snapshot.url} @ ${snapshot.date}`),
      "probe statuses are availability checks, not complete enumeration",
    ],
  };
}
