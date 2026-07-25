import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatSetup,
  installUserBundle,
  installUserHooks,
  refreshUserInstall,
  runSetup,
  userHookPath,
  userHooksNeedRefresh,
} from "../../src/copilot/setup.js";

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

function tempGoalPlugin() {
  const root = tempPlugin();
  for (const name of ["goal", "project-goal"]) {
    const target = path.join(root, ".github", "skills", name);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      path.join(target, "SKILL.md"),
      readFileSync(path.join(process.cwd(), ".github", "skills", name, "SKILL.md"), "utf8"),
      "utf8",
    );
  }
  return root;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function tempPluginWithHooksManifest(manifest: string) {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-setup-plugin-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"plugin"}');
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  writeFileSync(path.join(root, "hooks", "hooks.json"), manifest, "utf8");
  return root;
}

const PLUGIN_ROOT_ENV_VARS = [
  "COPILOT_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "OMP_PLUGIN_ROOT",
  "OMC_PLUGIN_ROOT",
];

function envWithoutPluginRoots() {
  const env = { ...process.env };
  for (const key of PLUGIN_ROOT_ENV_VARS) delete env[key];
  return env;
}

function templatePreToolUseCommand() {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "hooks", "hooks.json"), "utf8")) as {
    hooks: { preToolUse: Array<{ bash: string }> };
  };
  return manifest.hooks.preToolUse[0].bash;
}

function runHookCommand(bash: string) {
  return runShellCommand(bash, envWithoutPluginRoots());
}

function runShellCommand(bash: string, env: NodeJS.ProcessEnv) {
  return spawnSync("/bin/sh", ["-c", bash], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
    timeout: 5000,
  });
}

function expectNoOpJson(result: ReturnType<typeof runHookCommand>) {
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({});
}

describe("hook command crash safety", () => {
  it("bare preToolUse template command exits 0 with JSON when plugin-root vars are unset", () => {
    const bash = templatePreToolUseCommand();

    expect(bash).toContain(" || echo '{}'");
    expectNoOpJson(runHookCommand(bash));
  });

  it("installed pinned preToolUse command keeps the JSON fallback after the export prefix", () => {
    const home = tempHome();
    const plugin = tempPluginWithHooksManifest(readFileSync(path.join(process.cwd(), "hooks", "hooks.json"), "utf8"));

    installUserHooks({ pluginRoot: plugin, copilotHome: home });

    const installed = JSON.parse(readFileSync(path.join(home, "hooks", "omp.json"), "utf8")) as {
      hooks: { preToolUse: Array<{ bash: string }> };
    };
    const bash = installed.hooks.preToolUse[0].bash;
    expect(bash).toContain(`export COPILOT_PLUGIN_ROOT='${plugin}'`);
    expect(bash).toContain(" || echo '{}'");
    expectNoOpJson(runHookCommand(bash));
  });
});

describe("runSetup", () => {
  it("dry-runs without writing files (default scope=user → home)", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scope).toBe("user");
    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "copilot-instructions.md"))).toBe(false);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false);
    const targets = result.actions.map((a) => a.target);
    expect(targets).toContain(path.join(home, "skills", "hello", "SKILL.md"));
    expect(targets).toContain(path.join(home, "agents", "planner.md"));
    expect(targets).not.toContain(path.join(project, ".github", "skills", "hello", "SKILL.md"));
    expect(targets).toContain(path.join(project, ".github", "copilot-instructions.md"));
    expect(targets).toContain(path.join(project, ".omp", "state"));
    expect(targets).toContain(path.join(home, "hooks", "omp.json"));
  });

  it("copies bundled skills + agents into user home by default (not project)", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "agents", "planner.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "skills"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "agents"))).toBe(false);
    const instructions = readFileSync(path.join(project, ".github", "copilot-instructions.md"), "utf8");
    expect(instructions).toContain("oh-my-copilot");
    expect(existsSync(path.join(project, ".omp", "state"))).toBe(true);
  });

  it("--scope project copies skills + agents into the project .github", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: home,
      scope: "project",
    });

    expect(result.scope).toBe("project");
    expect(existsSync(path.join(project, ".github", "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "agents", "planner.md"))).toBe(true);
    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true); // hooks always user
  });

  it("reports skip-changed (not skip-exists) when a bundled skill differs, and does not overwrite", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const localSkill = path.join(home, "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, "LOCAL EDIT", "utf8");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    const action = result.actions.find((a) => a.target === localSkill);
    expect(action?.kind).toBe("skip-changed");
    expect(readFileSync(localSkill, "utf8")).toBe("LOCAL EDIT"); // untouched
  });

  it("skips an identical bundled skill as skip-exists", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const localSkill = path.join(home, "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, readFileSync(path.join(plugin, ".github", "skills", "hello", "SKILL.md"), "utf8"));

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    expect(result.actions.find((a) => a.target === localSkill)?.kind).toBe("skip-exists");
  });

  it("--force overrides a changed bundled skill with the bundled content", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const localSkill = path.join(home, "skills", "hello", "SKILL.md");
    mkdirSync(path.dirname(localSkill), { recursive: true });
    writeFileSync(localSkill, "LOCAL EDIT", "utf8");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home, force: true });
    const action = result.actions.find((a) => a.target === localSkill);
    expect(action?.kind).toBe("update");
    expect(readFileSync(localSkill, "utf8")).toContain("Says hello"); // bundled content restored
  });

  it("migrates the hash-known legacy /goal skill without changing .omp/goal.md", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const legacy = readFileSync(
      path.join(process.cwd(), "test", "fixtures", "legacy-goal-skill.md"),
      "utf8",
    );
    const goalTarget = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(goalTarget), { recursive: true });
    writeFileSync(goalTarget, legacy, "utf8");
    mkdirSync(path.join(project, ".omp"), { recursive: true });
    writeFileSync(path.join(project, ".omp", "goal.md"), "# Repo Goal\n\nKeep this objective\n");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.actions.find((action) => action.target === goalTarget)?.kind).toBe("update");
    expect(readFileSync(goalTarget, "utf8")).toBe(
      readFileSync(path.join(plugin, ".github", "skills", "goal", "SKILL.md"), "utf8"),
    );
    expect(existsSync(path.join(home, "skills", "project-goal", "SKILL.md"))).toBe(true);
    expect(readFileSync(path.join(project, ".omp", "goal.md"), "utf8")).toContain(
      "Keep this objective",
    );
    const manifest = JSON.parse(
      readFileSync(path.join(home, "omp-bundle-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      version: 2,
      scope: "user",
      validation: {
        bundle: { status: "valid" },
        catalog: { status: "absent" },
      },
    });
  });

  it("reports a known legacy /goal migration in dry-run without writing it or a manifest", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const legacy = readFileSync(
      path.join(process.cwd(), "test", "fixtures", "legacy-goal-skill.md"),
      "utf8",
    );
    const goalTarget = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(goalTarget), { recursive: true });
    writeFileSync(goalTarget, legacy, "utf8");

    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: home,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.actions.find((action) => action.target === goalTarget)?.kind).toBe("update");
    expect(readFileSync(goalTarget, "utf8")).toBe(legacy);
    expect(existsSync(path.join(home, "skills", "project-goal", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(home, "omp-bundle-manifest.json"))).toBe(false);
  });

  it("protects an unknown effective /goal while installing unaffected files, even with --force", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const goalTarget = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(goalTarget), { recursive: true });
    writeFileSync(goalTarget, "CUSTOM GOAL WORKFLOW\n", "utf8");

    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: home,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: "UNKNOWN_EFFECTIVE_GOAL",
        path: goalTarget,
      }),
    );
    expect(readFileSync(goalTarget, "utf8")).toBe("CUSTOM GOAL WORKFLOW\n");
    expect(existsSync(path.join(home, "skills", "project-goal", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "copilot-instructions.md"))).toBe(true);
    const formatted = formatSetup(result);
    expect(formatted).toContain("move or rename");
    expect(formatted).not.toContain("re-run with --force");
  });

  it("uses project > user > bundle precedence when finding an unknown effective /goal", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const projectGoal = path.join(project, ".github", "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(projectGoal), { recursive: true });
    writeFileSync(projectGoal, "PROJECT CUSTOM GOAL\n", "utf8");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(true);
    expect(result.validation.goalDiscovery.map((entry) => entry.scope)).toEqual([
      "project",
      "user",
      "bundle",
    ]);
    expect(result.validation.effectiveGoalPath).toBe(projectGoal);
    expect(existsSync(path.join(home, "skills", "goal", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
  });

  it("never overwrites a shadowed unknown /goal target, even with --force", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const projectGoal = path.join(project, ".github", "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(projectGoal), { recursive: true });
    writeFileSync(
      projectGoal,
      readFileSync(path.join(plugin, ".github", "skills", "goal", "SKILL.md"), "utf8"),
      "utf8",
    );
    const userGoal = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(userGoal), { recursive: true });
    writeFileSync(userGoal, "USER CUSTOM GOAL\n", "utf8");

    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: home,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.actions.find((action) => action.target === userGoal)?.kind).toBe(
      "skip-changed",
    );
    expect(readFileSync(userGoal, "utf8")).toBe("USER CUSTOM GOAL\n");
  });

  it("upgrades a v1 managed-file manifest to v2 with validated bundle state", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const target = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "MANAGED LEGACY GOAL\n", "utf8");
    writeFileSync(
      path.join(home, "omp-bundle-manifest.json"),
      JSON.stringify({
        version: 1,
        files: {
          "skills/goal/SKILL.md": sha256(readFileSync(target)),
        },
      }),
      "utf8",
    );

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });
    const manifest = JSON.parse(
      readFileSync(path.join(home, "omp-bundle-manifest.json"), "utf8"),
    );

    expect(result.ok).toBe(true);
    expect(result.actions.find((action) => action.target === target)?.kind).toBe("update");
    expect(manifest.version).toBe(2);
    expect(manifest.validation.bundle.status).toBe("valid");
    expect(manifest.files["skills/goal/SKILL.md"]).toBe(
      sha256(readFileSync(path.join(plugin, ".github", "skills", "goal", "SKILL.md"))),
    );
  });

  it("treats goal content that drifted from its manifest hash as unknown", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const target = path.join(home, "skills", "goal", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "EDITED AFTER INSTALL\n", "utf8");
    writeFileSync(
      path.join(home, "omp-bundle-manifest.json"),
      JSON.stringify({
        version: 1,
        files: {
          "skills/goal/SKILL.md": sha256("ORIGINAL MANAGED CONTENT\n"),
        },
      }),
      "utf8",
    );

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_EFFECTIVE_GOAL", path: target }),
    );
    expect(readFileSync(target, "utf8")).toBe("EDITED AFTER INSTALL\n");
  });

  it("writes a project-scoped v2 manifest under .omp", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();

    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: tempHome(),
      scope: "project",
    });
    const manifestPath = path.join(project, ".omp", "omp-bundle-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(result.ok).toBe(true);
    expect(manifest).toMatchObject({
      version: 2,
      scope: "project",
      root: project,
      validation: { bundle: { status: "valid" } },
    });
    expect(manifest.files).toHaveProperty(".github/skills/goal/SKILL.md");
  });

  it("rejects a mismatched catalog before copying any bundle file", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    mkdirSync(path.join(plugin, "catalog"), { recursive: true });
    writeFileSync(
      path.join(plugin, "catalog", "capabilities.json"),
      JSON.stringify({
        schemaVersion: 1,
        providerStates: ["native"],
        capabilities: [],
      }),
    );
    writeFileSync(
      path.join(plugin, "catalog", "skills-general.json"),
      JSON.stringify({
        schemaVersion: 1,
        canonicalRoot: ".",
        commandPrefix: "/",
        skills: [{
          name: "ghost",
          capabilityId: "missing",
          capabilityIds: ["missing"],
          source: "ghost",
          sourcePath: "ghost",
          canonicalPath: "ghost",
          description: "ghost",
          aliases: [],
          slashCommands: ["ghost"],
          projections: {},
          summary: "ghost",
          support: "ghost",
          projection: "skill-wrapper",
          phase1: false,
        }],
      }),
    );

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ code: "CATALOG_INVALID" }),
    );
    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(false);
  });

  it("rejects a symlinked bundle entry before following or copying it", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const outside = path.join(tempHome(), "outside-skill.md");
    writeFileSync(outside, "outside\n", "utf8");
    const escaped = path.join(plugin, ".github", "skills", "escape", "SKILL.md");
    mkdirSync(path.dirname(escaped), { recursive: true });
    symlinkSync(outside, escaped);

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ code: "BUNDLE_SYMLINK", path: escaped }),
    );
    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(false);
  });

  it("rejects a symlinked install target before --force can write outside the scope", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const outside = tempHome();
    const outsideSkill = path.join(outside, "SKILL.md");
    writeFileSync(outsideSkill, "DO NOT OVERWRITE\n", "utf8");
    mkdirSync(path.join(home, "skills"), { recursive: true });
    symlinkSync(outside, path.join(home, "skills", "hello"));

    const result = runSetup({
      cwd: project,
      pluginRoot: plugin,
      copilotHome: home,
      force: true,
    });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: "TARGET_SYMLINK",
        path: path.join(home, "skills", "hello"),
      }),
    );
    expect(readFileSync(outsideSkill, "utf8")).toBe("DO NOT OVERWRITE\n");
    expect(existsSync(path.join(home, "skills", "project-goal", "SKILL.md"))).toBe(false);
  });

  it("reports a blocking conflict for a symlinked hooks directory without writing outside the user scope", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const outside = tempHome();
    symlinkSync(outside, path.join(home, "hooks"), "dir");

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: "TARGET_SYMLINK",
        path: path.join(home, "hooks", "omp.json"),
      }),
    );
    expect(existsSync(path.join(outside, "omp.json"))).toBe(false);
  });

  it("reports legacy /goal routing without blocking unrelated user installation", () => {
    const project = tempProject();
    const plugin = tempGoalPlugin();
    const home = tempHome();
    const instruction = path.join(
      project,
      ".github",
      "instructions",
      "legacy.instructions.md",
    );
    mkdirSync(path.dirname(instruction), { recursive: true });
    writeFileSync(
      instruction,
      "The repo goal lives at .omp/goal.md. Run omp goal set or omp goal read.\n",
      "utf8",
    );

    const result = runSetup({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(true);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({ code: "LEGACY_GOAL_INSTRUCTIONS", path: instruction }),
    );
    expect(result.validation.instructionSources.map((source) => source.path)).toEqual(
      [...result.validation.instructionSources.map((source) => source.path)].sort(),
    );
    expect(existsSync(path.join(home, "skills", "goal", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
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

  it("reports skip-source-invalid for an unparseable hooks manifest", () => {
    const project = tempProject();
    const plugin = mkdtempSync(path.join(tmpdir(), "omc-setup-badhooks-"));
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
    const plugin = path.join(mkdtempSync(path.join(tmpdir(), "omc-setup-exec-")), "plugin with space");
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

    const result = runShellCommand(bash, { ...process.env, MARKER: marker });
    expect(result.status).toBe(0);
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
    const parent = mkdtempSync(path.join(tmpdir(), "omc-tricky-"));
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

describe("installUserHooks", () => {
  it("installs hooks but does NOT scaffold the project's .github", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const { actions } = installUserHooks({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
    // hooks-only path must not copy skills/agents anywhere
    expect(existsSync(path.join(project, ".github", "skills"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "agents"))).toBe(false);
    expect(existsSync(path.join(home, "skills"))).toBe(false);
    expect(actions.some((a) => a.target.endsWith("omp.json"))).toBe(true);
  });

  it("rejects a symlinked hooks directory without writing outside the user scope", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const outside = tempHome();
    symlinkSync(outside, path.join(home, "hooks"), "dir");

    const result = installUserHooks({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: "TARGET_SYMLINK",
        path: path.join(home, "hooks", "omp.json"),
      }),
    );
    expect(existsSync(path.join(outside, "omp.json"))).toBe(false);
  });
});

describe("installUserBundle / refreshUserInstall (used by omp update + auto-update)", () => {
  it("installUserBundle copies skills/agents to user home, not project", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    installUserBundle({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "agents", "planner.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "skills"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "agents"))).toBe(false);
    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(false); // bundle only
  });

  it("refreshUserInstall installs hooks + user skills/agents without project scaffold", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const { actions } = refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(existsSync(path.join(home, "hooks", "omp.json"))).toBe(true);
    expect(existsSync(path.join(home, "skills", "hello", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "agents", "planner.md"))).toBe(true);
    expect(existsSync(path.join(project, ".github", "skills"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "agents"))).toBe(false);
    expect(existsSync(path.join(project, ".github", "copilot-instructions.md"))).toBe(false);
    expect(actions.some((a) => a.target.endsWith("omp.json"))).toBe(true);
  });

  it("reports a blocking conflict for a symlinked hooks directory without writing outside the user scope", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const outside = tempHome();
    symlinkSync(outside, path.join(home, "hooks"), "dir");

    const result = refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toContainEqual(
      expect.objectContaining({
        code: "TARGET_SYMLINK",
        path: path.join(home, "hooks", "omp.json"),
      }),
    );
    expect(existsSync(path.join(outside, "omp.json"))).toBe(false);
  });

  it("updates an unmodified bundled copy when the bundle changes (managed-file migration)", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const skillTarget = path.join(home, "skills", "hello", "SKILL.md");
    refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    // Bundle ships a new version of the skill; the user never touched their copy.
    writeFileSync(path.join(plugin, ".github", "skills", "hello", "SKILL.md"), "BUNDLED V2", "utf8");
    const result = refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.actions.find((a) => a.target === skillTarget)?.kind).toBe("update");
    expect(readFileSync(skillTarget, "utf8")).toBe("BUNDLED V2");
  });

  it("still skips a genuinely user-edited copy when the bundle changes", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const skillTarget = path.join(home, "skills", "hello", "SKILL.md");
    refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    writeFileSync(skillTarget, "LOCAL EDIT", "utf8"); // real user edit after install
    writeFileSync(path.join(plugin, ".github", "skills", "hello", "SKILL.md"), "BUNDLED V2", "utf8");
    const result = refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.actions.find((a) => a.target === skillTarget)?.kind).toBe("skip-changed");
    expect(readFileSync(skillTarget, "utf8")).toBe("LOCAL EDIT");
  });

  it("keeps skip-changed for pre-manifest installs (no recorded hash to trust)", () => {
    const project = tempProject();
    const plugin = tempPlugin();
    const home = tempHome();
    const skillTarget = path.join(home, "skills", "hello", "SKILL.md");
    refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });
    // Simulate a legacy install: the copy exists but the manifest does not.
    rmSync(path.join(home, "omp-bundle-manifest.json"));

    writeFileSync(path.join(plugin, ".github", "skills", "hello", "SKILL.md"), "BUNDLED V2", "utf8");
    const result = refreshUserInstall({ cwd: project, pluginRoot: plugin, copilotHome: home });

    expect(result.actions.find((a) => a.target === skillTarget)?.kind).toBe("skip-changed");
  });
});

describe("formatSetup", () => {
  it("renders DRY-RUN prefix for dry runs", () => {
    const text = formatSetup({
      ok: true,
      dryRun: true,
      scope: "user",
      actions: [{ source: "(template)", target: "/tmp/x", kind: "create" }],
      paths: {} as never,
    });
    expect(text).toContain("DRY-RUN");
    expect(text).toContain("[create] /tmp/x");
  });
});
