import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, resolveProjectPaths } from "../project.js";

export interface CatalogedItem {
  name: string;
  kind: "skill" | "agent" | "capability";
  description?: string;
  path?: string;
}

export interface CombinedList {
  skills: CatalogedItem[];
  agents: CatalogedItem[];
  capabilities: CatalogedItem[];
}

function readSkillDir(dir: string): CatalogedItem[] {
  if (!existsSync(dir)) return [];
  const out: CatalogedItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
    out.push({
      name: fm.name || entry.name,
      kind: "skill",
      description: fm.description,
      path: skillFile,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readAgentDir(dir: string): CatalogedItem[] {
  if (!existsSync(dir)) return [];
  const out: CatalogedItem[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const fm = parseFrontmatter(readFileSync(filePath, "utf8"));
    out.push({
      name: fm.name || entry.name.replace(/\.md$/, ""),
      kind: "agent",
      description: fm.description,
      path: filePath,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readCapabilities(): Promise<CatalogedItem[]> {
  try {
    const { loadCatalogBundle } = await import("../catalog.js");
    const bundle = loadCatalogBundle();
    return bundle.capabilities.capabilities
      .filter((capability) => capability.phase1)
      .map((capability): CatalogedItem => ({
        name: capability.id,
        kind: "capability",
        description: capability.summary,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface ListOptions {
  cwd?: string;
  packageRoot?: string;
}

export async function listAll(options: ListOptions = {}): Promise<CombinedList> {
  const proj = resolveProjectPaths(options);
  const skillsDir = join(proj.packageRoot, ".github", "skills");
  const agentsDir = join(proj.packageRoot, ".github", "agents");
  return {
    skills: readSkillDir(skillsDir),
    agents: readAgentDir(agentsDir),
    capabilities: await readCapabilities(),
  };
}

export function formatList(list: CombinedList): string {
  const lines: string[] = [];
  lines.push(`Skills (${list.skills.length}):`);
  for (const s of list.skills) lines.push(`  /${s.name}${s.description ? `  ${s.description}` : ""}`);
  lines.push("", `Agents (${list.agents.length}):`);
  for (const a of list.agents) lines.push(`  @${a.name}${a.description ? `  ${a.description}` : ""}`);
  lines.push("", `Capabilities (${list.capabilities.length}):`);
  for (const c of list.capabilities) lines.push(`  ${c.name}${c.description ? `  ${c.description}` : ""}`);
  return lines.join("\n");
}
