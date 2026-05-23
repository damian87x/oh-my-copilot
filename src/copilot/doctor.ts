import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";

export type CheckStatus = "pass" | "fail" | "warn";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  paths: CopilotPaths;
}

export interface DoctorOptions extends ResolveCopilotPathsOptions {
  skipCopilot?: boolean;
  copilotBin?: string;
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.version.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= 20) {
    return { name: "node-version", status: "pass", detail: process.version };
  }
  return { name: "node-version", status: "fail", detail: `node ${process.version} (need >=20)` };
}

function checkPluginManifest(paths: CopilotPaths): DoctorCheck {
  const manifest = join(paths.pluginRoot, "plugin.json");
  if (!existsSync(manifest)) {
    return { name: "plugin-manifest", status: "fail", detail: `missing: ${manifest}` };
  }
  return { name: "plugin-manifest", status: "pass", detail: manifest };
}

function checkInstructions(paths: CopilotPaths): DoctorCheck {
  if (existsSync(paths.copilotInstructions)) {
    return { name: "copilot-instructions", status: "pass", detail: paths.copilotInstructions };
  }
  return {
    name: "copilot-instructions",
    status: "warn",
    detail: `missing (run \`omc setup\`): ${paths.copilotInstructions}`,
  };
}

function checkSkillsDiscovery(paths: CopilotPaths): DoctorCheck {
  if (existsSync(paths.projectScopeSkills)) {
    return { name: "skills-discovery", status: "pass", detail: paths.projectScopeSkills };
  }
  return {
    name: "skills-discovery",
    status: "warn",
    detail: `no skills directory: ${paths.projectScopeSkills}`,
  };
}

function checkHooksManifest(paths: CopilotPaths): DoctorCheck {
  if (existsSync(paths.hooksManifest)) {
    return { name: "hooks-manifest", status: "pass", detail: paths.hooksManifest };
  }
  return {
    name: "hooks-manifest",
    status: "warn",
    detail: `not present: ${paths.hooksManifest}`,
  };
}

function checkCopilotCli(bin: string): DoctorCheck {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 });
    if (result.status === 0) {
      const detail = (result.stdout || result.stderr || "present").trim().split("\n")[0] ?? "present";
      return { name: "copilot-cli", status: "pass", detail };
    }
    return { name: "copilot-cli", status: "fail", detail: `${bin} --version exited ${result.status ?? "?"}` };
  } catch {
    return { name: "copilot-cli", status: "fail", detail: `${bin} not found on PATH` };
  }
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const paths = resolveCopilotPaths(options);
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkPluginManifest(paths),
    checkInstructions(paths),
    checkSkillsDiscovery(paths),
    checkHooksManifest(paths),
  ];
  if (!options.skipCopilot) {
    checks.push(checkCopilotCli(options.copilotBin ?? "copilot"));
  }
  const ok = checks.every((c) => c.status !== "fail");
  return { ok, checks, paths };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`omc doctor ${report.ok ? "OK" : "FAIL"}`];
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    lines.push(`  ${icon} ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}
