import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSetup, runSetup } from "../../src/copilot/setup.js";

function tempProject() {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-setup-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
  return root;
}

function tempPlugin() {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-setup-plugin-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"plugin"}');
  const skill = path.join(root, ".github", "skills", "hello");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\nname: hello\ndescription: Says hello.\n---\n\nBody.\n",
  );
  const agent = path.join(root, ".github", "agents");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    path.join(agent, "planner.md"),
    "---\nname: planner\ndescription: Plans.\n---\n\nBody.\n",
  );
  return root;
}

describe("runSetup", () => {
  it("dry-runs without writing files", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const result = runSetup({ cwd: project, pluginRoot: plugin, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "copilot-instructions.md"))).toBe(false);
    const targets = result.actions.map((a) => a.target);
    expect(targets).toContain(path.join(project, ".github", "skills", "hello", "SKILL.md"));
    expect(targets).toContain(path.join(project, ".github", "agents", "planner.md"));
    expect(targets).toContain(path.join(project, ".github", "copilot-instructions.md"));
    expect(targets).toContain(path.join(project, ".omc", "state"));
  });

  it("copies bundled skills + agents and creates instructions template", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    runSetup({ cwd: project, pluginRoot: plugin });

    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "agents", "planner.md"))).toBe(true);
    const instructions = readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8");
    expect(instructions).toContain("oh-my-copilot");
    expect(existsSync(path.join(project, ".omc", "state"))).toBe(true);
  });

  it("preserves existing copilot-instructions.md", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    mkdirSync(path.join(project, ".github"), { recursive: true });
    writeFileSync(path.join(project, ".github", "copilot-instructions.md"), "# custom", "utf8");

    runSetup({ cwd: project, pluginRoot: plugin });

    expect(readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8")).toBe("# custom");
  });
});

describe("formatSetup", () => {
  it("renders DRY-RUN prefix for dry runs", () => {
    const text = formatSetup({
      ok: true,
      dryRun: true,
      scope: "project",
      actions: [{ source: "(template)", target: "/tmp/x", kind: "create" }],
      paths: {} as never,
    });
    expect(text).toContain("DRY-RUN");
    expect(text).toContain("[create] /tmp/x");
  });
});
