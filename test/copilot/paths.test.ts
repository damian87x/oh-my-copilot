import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCopilotPaths } from "../../src/copilot/paths.js";

function tempProject() {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-paths-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
  return root;
}

describe("resolveCopilotPaths", () => {
  it("derives project + state paths from cwd", () => {
    const root = tempProject();
    const paths = resolveCopilotPaths({ cwd: root });
    expect(paths.projectRoot).toBe(root);
    expect(paths.stateDir).toBe(path.join(root, ".omc", "state"));
    expect(paths.projectScopeSkills).toBe(path.join(root, ".github", "skills"));
    expect(paths.copilotInstructions).toBe(path.join(root, ".github", "copilot-instructions.md"));
  });

  it("honours OMC_PLUGIN_ROOT for pluginRoot", () => {
    const projectRoot = tempProject();
    const pluginRoot = tempProject();
    const original = process.env.OMC_PLUGIN_ROOT;
    process.env.OMC_PLUGIN_ROOT = pluginRoot;
    try {
      const paths = resolveCopilotPaths({ cwd: projectRoot });
      expect(paths.pluginRoot).toBe(pluginRoot);
      expect(paths.hooksManifest).toBe(path.join(pluginRoot, "hooks", "hooks.json"));
      expect(paths.scriptsDir).toBe(path.join(pluginRoot, "scripts"));
    } finally {
      if (original === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = original;
    }
  });

  it("explicit pluginRoot overrides env", () => {
    const projectRoot = tempProject();
    const envPlugin = tempProject();
    const explicitPlugin = tempProject();
    const original = process.env.OMC_PLUGIN_ROOT;
    process.env.OMC_PLUGIN_ROOT = envPlugin;
    try {
      const paths = resolveCopilotPaths({ cwd: projectRoot, pluginRoot: explicitPlugin });
      expect(paths.pluginRoot).toBe(explicitPlugin);
    } finally {
      if (original === undefined) delete process.env.OMC_PLUGIN_ROOT;
      else process.env.OMC_PLUGIN_ROOT = original;
    }
  });
});
