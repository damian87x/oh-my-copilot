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

// Isolated copilot home so hook installs never touch the developer's real ~/.copilot.
function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "omc-copilot-setup-home-"));
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
  const hooks = path.join(root, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    path.join(hooks, "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: {
        sessionEnd: [
          { type: "command", bash: 'node "${COPILOT_PLUGIN_ROOT:-$OMC_PLUGIN_ROOT}"/scripts/session-end.mjs', timeoutSec: 5 },
        ],
        preToolUse: [
          { type: "command", bash: 'node "${COPILOT_PLUGIN_ROOT:-$OMC_PLUGIN_ROOT}"/scripts/pre-tool-use.mjs', timeoutSec: 5 },
        ],
      },
    }),
  );
  return root;
}

describe("runSetup", () => {
  it("dry-runs without writing files", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "copilot-instructions.md"))).toBe(false);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false);
    const targets = result.actions.map((a) => a.target);
    expect(targets).toContain(path.join(project, ".github", "skills", "hello", "SKILL.md"));
    expect(targets).toContain(path.join(project, ".github", "agents", "planner.md"));
    expect(targets).toContain(path.join(project, ".github", "copilot-instructions.md"));
    expect(targets).toContain(path.join(project, ".omp", "state"));
    expect(targets).toContain(path.join(home, "hooks", "omp.json"));
  });

  it("copies bundled skills + agents and creates instructions template", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: tempHome() });

    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "agents", "planner.md"))).toBe(true);
    const instructions = readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8");
    expect(instructions).toContain("oh-my-copilot");
    expect(existsSync(path.join(project, ".omp", "state"))).toBe(true);
  });

  it("preserves existing copilot-instructions.md", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    mkdirSync(path.join(project, ".github"), { recursive: true });
    writeFileSync(path.join(project, ".github", "copilot-instructions.md"), "# custom", "utf8");

    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: tempHome() });

    expect(readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8")).toBe("# custom");
  });

  it("installs plugin hooks into <copilotHome>/hooks/omp.json with the plugin root pinned", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    const target = path.join(home, "hooks", "omp.json");
    expect(existsSync(target)).toBe(true);
    const installed = JSON.parse(readFileSync(target, "utf8"));
    expect(installed.version).toBe(1);
    expect(Object.keys(installed.hooks)).toEqual(["sessionEnd", "preToolUse"]);
    const bash = installed.hooks.sessionEnd[0].bash as string;
    // plugin root is pinned absolutely so the script resolves without copilot env
    expect(bash).toContain(`COPILOT_PLUGIN_ROOT='${plugin}'`);
    expect(bash).toContain("scripts/session-end.mjs");
  });

  it("reports update on a second setup (managed file is refreshed)", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    const second = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    const hookAction = second.actions.find((a) => a.target === path.join(home, "hooks", "omp.json"));
    expect(hookAction?.kind).toBe("update");
  });

  it("skips hook install when the plugin ships no hooks manifest", () => {
    const project = tempProject();
    const plugin = mkdtempSync(path.join(tmpdir(), "omc-setup-nohooks-"));
    writeFileSync(path.join(plugin, "package.json"), '{"name":"p"}');
    const home = tempHome();
    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false);
    const hookAction = result.actions.find((a) => a.kind === "skip-source-missing");
    expect(hookAction).toBeTruthy();
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
