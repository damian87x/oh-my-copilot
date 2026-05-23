import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatDoctor, runDoctor } from "../../src/copilot/doctor.js";

function tempProjectWithPlugin() {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-doctor-"));
  writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
  writeFileSync(
    path.join(root, "plugin.json"),
    '{"name":"oh-my-copilot","version":"0.0.0"}',
  );
  return root;
}

describe("runDoctor", () => {
  it("reports warnings for missing optional pieces in a fresh project", () => {
    const root = tempProjectWithPlugin();
    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true });
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("node-version");
    expect(names).toContain("plugin-manifest");
    expect(names).toContain("copilot-instructions");
    expect(names).toContain("skills-discovery");
    expect(names).toContain("hooks-manifest");
    expect(names).not.toContain("copilot-cli");

    const instructions = report.checks.find((c) => c.name === "copilot-instructions");
    expect(instructions?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("passes when manifest + instructions + skills + hooks exist", () => {
    const root = tempProjectWithPlugin();
    mkdirSync(path.join(root, ".github", "skills"), { recursive: true });
    writeFileSync(path.join(root, ".github", "copilot-instructions.md"), "# instructions");
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(path.join(root, "hooks", "hooks.json"), "{}");

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true });
    const passing = report.checks.filter((c) => c.status === "pass").map((c) => c.name);
    expect(passing).toContain("plugin-manifest");
    expect(passing).toContain("copilot-instructions");
    expect(passing).toContain("skills-discovery");
    expect(passing).toContain("hooks-manifest");
    expect(report.ok).toBe(true);
  });

  it("fails when plugin manifest is missing", () => {
    const project = mkdtempSync(path.join(tmpdir(), "omc-copilot-doctor-noplugin-"));
    writeFileSync(path.join(project, "package.json"), '{"name":"tmp"}');
    const report = runDoctor({ cwd: project, pluginRoot: project, skipCopilot: true });
    const manifest = report.checks.find((c) => c.name === "plugin-manifest");
    expect(manifest?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("reports failure when copilot binary is unavailable", () => {
    const root = tempProjectWithPlugin();
    const report = runDoctor({
      cwd: root,
      pluginRoot: root,
      copilotBin: "definitely-not-a-real-binary-xyz",
    });
    const copilot = report.checks.find((c) => c.name === "copilot-cli");
    expect(copilot?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });
});

describe("formatDoctor", () => {
  it("renders one line per check", () => {
    const text = formatDoctor({
      ok: true,
      paths: {} as never,
      checks: [
        { name: "node-version", status: "pass", detail: "v22.0.0" },
        { name: "copilot-instructions", status: "warn", detail: "missing" },
      ],
    });
    expect(text.split("\n")).toHaveLength(3); // header + 2 checks
    expect(text).toContain("✓ node-version");
    expect(text).toContain("! copilot-instructions");
  });
});
