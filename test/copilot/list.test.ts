import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatList, listAll } from "../../src/copilot/list.js";

function tempProject() {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-list-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
  return root;
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".github", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeAgent(root: string, name: string, description: string): void {
  const dir = path.join(root, ".github", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

describe("listAll", () => {
  it("collects skills and agents from .github/", async () => {
    const root = tempProject();
    writeSkill(root, "alpha", "First skill");
    writeSkill(root, "beta", "Second skill");
    writeAgent(root, "planner", "Plan things");

    const result = await listAll({ cwd: root });

    expect(result.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(result.skills[0]?.description).toBe("First skill");
    expect(result.agents.map((a) => a.name)).toEqual(["planner"]);
    expect(result.agents[0]?.description).toBe("Plan things");
  });

  it("returns empty arrays when nothing is installed", async () => {
    const root = tempProject();
    const result = await listAll({ cwd: root });
    expect(result.skills).toEqual([]);
    expect(result.agents).toEqual([]);
  });
});

describe("formatList", () => {
  it("renders a labelled summary", () => {
    const text = formatList({
      skills: [{ name: "alpha", kind: "skill", description: "First" }],
      agents: [{ name: "planner", kind: "agent" }],
      capabilities: [],
    });
    expect(text).toContain("Skills (1):");
    expect(text).toContain("/alpha  First");
    expect(text).toContain("Agents (1):");
    expect(text).toContain("@planner");
    expect(text).toContain("Capabilities (0):");
  });
});
