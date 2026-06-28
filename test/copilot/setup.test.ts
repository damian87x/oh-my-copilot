import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatSetup, installUserHooks, runSetup, userHookPath, userHooksNeedRefresh } from "../../src/copilot/setup.js";

function tempProject() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-copilot-setup-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
  return root;
}

// Isolated copilot home so hook installs never touch the developer's real ~/.copilot.
function tempHome() {
  return mkdtempSync(path.join(tmpdir(), "omp-copilot-setup-home-"));
}

function tempPlugin() {
  const root = mkdtempSync(path.join(tmpdir(), "omp-copilot-setup-plugin-"));
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

  it("reports skip-changed (not skip-exists) when a bundled skill differs, and does not overwrite", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const localSkill = path.join(project, ".github", "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, "LOCAL EDIT", "utf8");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: tempHome() });
    const action = result.actions.find((a) => a.target === localSkill);
    expect(action?.kind).toBe("skip-changed");
    expect(readFileSync(localSkill, "utf8")).toBe("LOCAL EDIT"); // untouched
  });

  it("skips an identical bundled skill as skip-exists", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const localSkill = path.join(project, ".github", "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, readFileSync(path.join(plugin, ".github", "skills", "hello", "SKILL.md"), "utf8"));

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: tempHome() });
    expect(result.actions.find((a) => a.target === localSkill)?.kind).toBe("skip-exists");
  });

  it("--force overrides a changed bundled skill with the bundled content", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const localSkill = path.join(project, ".github", "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, "LOCAL EDIT", "utf8");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: tempHome(), force: true });
    const action = result.actions.find((a) => a.target === localSkill);
    expect(action?.kind).toBe("update");
    expect(readFileSync(localSkill, "utf8")).toContain("Says hello"); // bundled content restored
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
    const plugin = mkdtempSync(path.join(tmpdir(), "omp-setup-nohooks-"));
    writeFileSync(path.join(plugin, "package.json"), '{"name":"p"}');
    const home = tempHome();
    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false);
    const hookAction = result.actions.find((a) => a.kind === "skip-source-missing");
    expect(hookAction).toBeTruthy();
  });

  it("reports skip-source-invalid for an unparseable hooks manifest", () => {
    const project = tempProject();
    const plugin = mkdtempSync(path.join(tmpdir(), "omp-setup-badhooks-"));
    writeFileSync(path.join(plugin, "package.json"), '{"name":"p"}');
    mkdirSync(path.join(plugin, "hooks"), { recursive: true });
    writeFileSync(path.join(plugin, "hooks", "hooks.json"), "{ not json");
    const home = tempHome();
    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false);
    expect(result.actions.some((a) => a.kind === "skip-source-invalid")).toBe(true);
  });

  // Codex catch: a `VAR=x cmd "${VAR:-…}"` prefix is NOT visible to the command's
  // own expansion. This test EXECUTES the generated bash (plugin path has a space)
  // and proves the script actually resolves + runs from the pinned plugin root.
  it("generated hook bash resolves the plugin root and runs the script (path with spaces)", () => {
    const project = tempProject();
    const home = tempHome();
    // plugin root containing a space
    const plugin = path.join(mkdtempSync(path.join(tmpdir(), "omp-setup-exec-")), "plugin with space");
    mkdirSync(path.join(plugin, "scripts"), { recursive: true });
    mkdirSync(path.join(plugin, "hooks"), { recursive: true });
    const marker = path.join(home, "ran.marker");
    writeFileSync(
      path.join(plugin, "scripts", "probe.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(process.env.MARKER, "ok");`,
    );
    writeFileSync(
      path.join(plugin, "hooks", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionEnd: [
            { type: "command", bash: 'node "${COPILOT_PLUGIN_ROOT:-$OMC_PLUGIN_ROOT}"/scripts/probe.mjs', timeoutSec: 5 },
          ],
        },
      }),
    );

    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    const installed = JSON.parse(readFileSync(path.join(home, "hooks", "omp.json"), "utf8"));
    const bash = installed.hooks.sessionEnd[0].bash as string;

    execSync(bash, { env: { ...process.env, MARKER: marker }, shell: "/bin/sh" });
    expect(existsSync(marker)).toBe(true); // script ran → plugin root resolved correctly
  });
});

describe("userHookPath", () => {
  it("points at <copilotHome>/hooks/omp.json and matches where installUserHooks writes", () => {
    const home = tempHome();
    const p = userHookPath({ copilotHome: home });
    expect(p).toBe(path.join(home, "hooks", "omp.json"));
    expect(existsSync(p)).toBe(false);
    installUserHooks({ cwd: tempProject(), pluginRoot: tempPlugin(), copilotHome: home });
    expect(existsSync(p)).toBe(true); // now installed at exactly that path
  });
});

describe("userHooksNeedRefresh", () => {
  it("is true when the hook file is missing", () => {
    expect(userHooksNeedRefresh({ copilotHome: tempHome() })).toBe(true);
  });

  it("is false right after install (pinned root == current)", () => {
    const home = tempHome();
    const plugin = tempPlugin();
    installUserHooks({ cwd: tempProject(), pluginRoot: plugin, copilotHome: home });
    expect(userHooksNeedRefresh({ cwd: tempProject(), pluginRoot: plugin, copilotHome: home })).toBe(false);
  });

  it("is true when the pinned plugin root differs from the current install (stale path)", () => {
    const home = tempHome();
    installUserHooks({ cwd: tempProject(), pluginRoot: tempPlugin(), copilotHome: home });
    // now omp 'runs' from a different install path → pinned path is stale
    expect(userHooksNeedRefresh({ cwd: tempProject(), pluginRoot: tempPlugin(), copilotHome: home })).toBe(true);
  });

  it("round-trips a pathological plugin path (quotes + literal ' OMP_PLUGIN_ROOT=') without a false refresh", () => {
    const home = tempHome();
    // a real dir whose name contains a single quote AND the literal marker the
    // greedy regex would have mis-stopped on
    const parent = mkdtempSync(path.join(tmpdir(), "omp-tricky-"));
    const tricky = path.join(parent, "we'ird OMP_PLUGIN_ROOT=plugin");
    mkdirSync(path.join(tricky, "hooks"), { recursive: true });
    writeFileSync(
      path.join(tricky, "hooks", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { sessionEnd: [{ type: "command", bash: 'node "${COPILOT_PLUGIN_ROOT:-x}"/scripts/session-end.mjs', timeoutSec: 5 }] } }),
    );
    installUserHooks({ pluginRoot: tricky, copilotHome: home });
    // pinned path round-trips → not stale (greedy regex would have returned true)
    expect(userHooksNeedRefresh({ pluginRoot: tricky, copilotHome: home })).toBe(false);
  });

  it("is true for an unparseable hook file", () => {
    const home = tempHome();
    mkdirSync(path.join(home, "hooks"), { recursive: true });
    writeFileSync(path.join(home, "hooks", "omp.json"), "{ not json");
    expect(userHooksNeedRefresh({ copilotHome: home })).toBe(true);
  });
});

describe("installUserHooks (used by omp update)", () => {
  it("installs hooks but does NOT scaffold the project's .github", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const { actions } = installUserHooks({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
    // update must not copy skills/agents into the cwd
    expect(existsSync(path.join(project, ".github", "skills"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "agents"))).toBe(false);
    expect(actions.some((a) => a.target.endsWith("omp.json"))).toBe(true);
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
