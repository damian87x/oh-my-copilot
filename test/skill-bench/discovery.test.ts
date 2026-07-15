import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkillBenchSkills, resolveModelCandidates } from "../../src/skill-bench/discovery.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omp-skill-bench-discovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skillDir(base: string, dirName: string, frontmatter: { name: string; description?: string }, extraFiles: Record<string, string> = {}): string {
  const dir = path.join(base, dirName);
  mkdirSync(dir, { recursive: true });
  const description = frontmatter.description === undefined ? "" : `description: ${frontmatter.description}\n`;
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${frontmatter.name}\n${description}---\n# ${frontmatter.name}\n`);
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

describe("dynamic skill discovery", () => {
  it("discovers project, user, plugin, direct-directory, and direct-file skills with duplicate names kept separate", () => {
    const projectRoot = path.join(root, "project", ".github", "skills");
    const userRoot = path.join(root, "home", ".copilot", "skills");
    const pluginRoot = path.join(root, "plugin", "skills");
    const directRoot = skillDir(path.join(root, "external"), "review", { name: "review", description: "External review skill" });
    const directSkillFile = path.join(directRoot, "SKILL.md");
    skillDir(projectRoot, "review-a", { name: "review", description: "Project review skill" });
    skillDir(userRoot, "review-b", { name: "review", description: "User review skill" });
    skillDir(pluginRoot, "ship", { name: "ship", description: "Plugin ship skill" });

    const result = discoverSkillBenchSkills({
      projectRoots: [projectRoot],
      userRoots: [userRoot],
      pluginRoots: [pluginRoot],
      explicitPaths: [directRoot, directSkillFile],
    });

    const reviews = result.skills.filter((skill) => skill.name === "review");
    expect(reviews).toHaveLength(4);
    expect(new Set(reviews.map((skill) => skill.canonicalPath)).size).toBe(3);
    expect(new Set(result.skills.map((skill) => skill.id)).size).toBe(result.skills.length);
    expect(reviews.map((skill) => skill.sourceKind).sort()).toEqual(["explicit", "explicit", "project", "user"]);
    expect(result.skills.every((skill) => skill.sourceUri.startsWith("file://"))).toBe(true);
    expect(result.skills.every((skill) => skill.fingerprint.length === 64)).toBe(true);
    expect(result.skills.find((skill) => skill.name === "ship")?.provenance.rootKind).toBe("plugin");
  });

  it("fails closed for invalid skill metadata and blocks root symlink escapes while allowing explicit external skills", () => {
    const projectRoot = path.join(root, "project-skills");
    mkdirSync(projectRoot, { recursive: true });
    skillDir(projectRoot, "missing-description", { name: "bad" });
    const invalid = path.join(projectRoot, "invalid");
    mkdirSync(invalid, { recursive: true });
    writeFileSync(path.join(invalid, "SKILL.md"), "---\nname: [not yaml\ndescription: bad\n---\n");
    const outside = skillDir(path.join(root, "outside"), "external", { name: "external", description: "Explicit external" });
    symlinkSync(outside, path.join(projectRoot, "escape-link"));

    const result = discoverSkillBenchSkills({ projectRoots: [projectRoot], explicitPaths: [outside] });

    expect(result.skills.map((skill) => skill.name)).toEqual(["external"]);
    expect(result.rejected.map((entry) => entry.reason).join("\n")).toContain("missing description");
    expect(result.rejected.map((entry) => entry.reason).join("\n")).toContain("invalid frontmatter");
    expect(result.rejected.map((entry) => entry.reason).join("\n")).toContain("symlink escape blocked");
  });

  it("rejects a symlinked discovery root before traversing it", () => {
    const workspace = path.join(root, "workspace");
    const realSkillsRoot = path.join(root, "outside-skills");
    mkdirSync(path.join(workspace, ".github"), { recursive: true });
    skillDir(realSkillsRoot, "external", { name: "external", description: "External skill" });
    const symlinkedRoot = path.join(workspace, ".github", "skills");
    symlinkSync(realSkillsRoot, symlinkedRoot);

    const result = discoverSkillBenchSkills({ projectRoots: [symlinkedRoot] });

    expect(result.skills).toEqual([]);
    expect(result.rejected).toContainEqual({ path: symlinkedRoot, reason: "symlink root blocked" });
  });

  it("fingerprints every file under a skill directory, not only SKILL.md", () => {
    const projectRoot = path.join(root, "project-skills");
    const dir = skillDir(projectRoot, "tdd", { name: "tdd", description: "TDD skill" }, { "examples/one.txt": "before" });
    const first = discoverSkillBenchSkills({ projectRoots: [projectRoot] }).skills[0].fingerprint;
    writeFileSync(path.join(dir, "examples", "one.txt"), "after");
    const second = discoverSkillBenchSkills({ projectRoots: [projectRoot] }).skills[0].fingerprint;
    expect(second).not.toBe(first);
  });
});

describe("dynamic model candidate resolution", () => {
  it("unions model sources, aggregates provenance, probes without treating timeouts as unavailable, and selects explicit unseen available models", async () => {
    const result = await resolveModelCandidates({
      historyObservedIds: ["gpt-5.5", "claude-opus"],
      configuredIds: ["gpt-5.5", "gpt-5.6-sol"],
      hostDefaultIds: ["auto"],
      explicitIds: ["new-user-model"],
      providerSnapshots: [{ url: "https://provider.example/models", date: "2026-07-14", modelIds: ["provider-public"] }],
      probe: async (id) => {
        if (id === "new-user-model") return { status: "available" };
        if (id === "gpt-5.6-sol") return { status: "timeout" };
        if (id === "claude-opus") return { status: "unavailable", reason: "not entitled" };
        return { status: "unknown" };
      },
    });

    expect(result.completeEnumeration).toBe(false);
    expect(result.enumerationProvenance).toContain("provider snapshot https://provider.example/models @ 2026-07-14");
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["gpt-5.5", "claude-opus", "gpt-5.6-sol", "auto", "new-user-model", "provider-public"]);
    expect(result.candidates.find((candidate) => candidate.id === "gpt-5.5")?.sources.sort()).toEqual(["configured", "history"]);
    expect(result.candidates.find((candidate) => candidate.id === "gpt-5.6-sol")?.probeStatus).toBe("unknown");
    expect(result.candidates.find((candidate) => candidate.id === "claude-opus")?.probeStatus).toBe("unavailable");
    expect(result.candidates.find((candidate) => candidate.id === "new-user-model")?.selectable).toBe(true);
    expect(result.candidates.find((candidate) => candidate.id === "provider-public")?.sources).toEqual(["provider-snapshot"]);
  });
});
