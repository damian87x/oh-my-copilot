import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("passes when manifest + instructions + skills + Copilot v1 hooks exist", () => {
    const root = tempProjectWithPlugin();
    mkdirSync(path.join(root, ".github", "skills"), { recursive: true });
    writeFileSync(path.join(root, ".github", "copilot-instructions.md"), "# instructions");
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: "node scripts/session-start.mjs" }],
          preToolUse: [{ type: "command", bash: "node scripts/pre-tool-use.mjs" }],
          postToolUse: [{ type: "command", bash: "node scripts/post-tool-use.mjs" }],
          errorOccurred: [{ type: "command", bash: "node scripts/error.mjs" }],
        },
      }),
    );

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true });
    const passing = report.checks.filter((c) => c.status === "pass").map((c) => c.name);
    expect(passing).toContain("plugin-manifest");
    expect(passing).toContain("copilot-instructions");
    expect(passing).toContain("skills-discovery");
    expect(passing).toContain("hooks-manifest");
    expect(report.ok).toBe(true);
  });


  it("fails when the hooks manifest is not Copilot v1 shaped", () => {
    const root = tempProjectWithPlugin();
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({ SessionStart: [] }));

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true });
    const hooks = report.checks.find((c) => c.name === "hooks-manifest");

    expect(hooks?.status).toBe("fail");
    expect(hooks?.detail).toMatch(/version: 1/);
    expect(hooks?.detail).toMatch(/hooks/);
    expect(report.ok).toBe(false);
  });

  it("fails when the hooks manifest uses unsupported event names", () => {
    const root = tempProjectWithPlugin();
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: { Error: [] } }));

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true });
    const hooks = report.checks.find((c) => c.name === "hooks-manifest");

    expect(hooks?.status).toBe("fail");
    expect(hooks?.detail).toMatch(/unsupported hook event/i);
    expect(hooks?.detail).toMatch(/errorOccurred|ErrorOccurred/);
  });


  it("runs configured command hooks when hook smoke is requested", () => {
    const root = tempProjectWithPlugin();
    const hookScript = path.join(root, "hook.mjs");
    const marker = path.join(root, "marker.json");
    writeFileSync(
      hookScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const raw = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(marker)}, raw);
console.log(JSON.stringify({}));
`,
    );
    chmodSync(hookScript, 0o755);
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: `node ${JSON.stringify(hookScript)}` }] } }),
    );

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true, checkHooks: true });
    const smoke = report.checks.find((c) => c.name === "hooks-smoke");

    expect(smoke?.status).toBe("pass");
    expect(readFileSync(marker, "utf8")).toContain('"toolName":"view"');
    expect(report.ok).toBe(true);
  });



  it("runs env-anchored command hooks from a non-plugin cwd without cwd shadowing", () => {
    const root = tempProjectWithPlugin();
    const scriptsDir = path.join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const hookScript = path.join(scriptsDir, "anchored-hook.mjs");
    const marker = path.join(root, "anchored-marker.json");
    writeFileSync(
      hookScript,
      `import { readFileSync, writeFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ processCwd: process.cwd(), payloadCwd: payload.cwd }));
console.log(JSON.stringify({}));
`,
    );
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    const command = "node -e \"import('node:url').then(({pathToFileURL}) => import(pathToFileURL(process.env.OMP_PLUGIN_ROOT + '/scripts/anchored-hook.mjs').href))\"";
    writeFileSync(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: command }] } }),
    );

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true, checkHooks: true });
    const markerJson = JSON.parse(readFileSync(marker, "utf8"));

    expect(report.checks.find((c) => c.name === "hooks-smoke")?.status).toBe("pass");
    expect(realpathSync(markerJson.processCwd)).not.toBe(realpathSync(root));
    expect(realpathSync(markerJson.payloadCwd)).toBe(realpathSync(markerJson.processCwd));
  });

  it("fails hook smoke when a command hook emits non-JSON stdout", () => {
    const root = tempProjectWithPlugin();
    const hookScript = path.join(root, "bad-hook.mjs");
    writeFileSync(hookScript, 'console.log("not-json");\n');
    mkdirSync(path.join(root, "hooks"), { recursive: true });
    writeFileSync(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", bash: `node ${JSON.stringify(hookScript)}` }] } }),
    );

    const report = runDoctor({ cwd: root, pluginRoot: root, skipCopilot: true, checkHooks: true });
    const smoke = report.checks.find((c) => c.name === "hooks-smoke");

    expect(smoke?.status).toBe("fail");
    expect(smoke?.detail).toMatch(/invalid stdout JSON/);
    expect(report.ok).toBe(false);
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
