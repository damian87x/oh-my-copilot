import { existsSync, readFileSync } from "node:fs";
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
    detail: `missing (run \`omp setup\`): ${paths.copilotInstructions}`,
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

// Recognized Copilot CLI hook events. `agentStop` powers the omp loop driver.
const COPILOT_HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "errorOccurred",
  "agentStop",
];

function checkHooksManifest(paths: CopilotPaths): DoctorCheck {
  if (!existsSync(paths.hooksManifest)) {
    return { name: "hooks-manifest", status: "warn", detail: `not present: ${paths.hooksManifest}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.hooksManifest, "utf8"));
  } catch {
    return { name: "hooks-manifest", status: "fail", detail: `invalid JSON: ${paths.hooksManifest}` };
  }
  const manifest = parsed as { version?: unknown; hooks?: Record<string, unknown> };
  if (manifest.version !== 1 || typeof manifest.hooks !== "object" || manifest.hooks === null) {
    return {
      name: "hooks-manifest",
      status: "fail",
      detail: `not Copilot v1 format (need {"version":1,"hooks":{…}}): ${paths.hooksManifest}`,
    };
  }
  const events = Object.keys(manifest.hooks);
  const unknown = events.filter((e) => !COPILOT_HOOK_EVENTS.includes(e));
  if (unknown.length > 0) {
    return {
      name: "hooks-manifest",
      status: "warn",
      detail: `unrecognized hook events ${unknown.join(", ")} (Claude-format?): ${paths.hooksManifest}`,
    };
  }
  const hasLoop = events.includes("agentStop");
  return {
    name: "hooks-manifest",
    status: "pass",
    detail: `Copilot v1, ${events.length} events${hasLoop ? " (agentStop loop driver present)" : ""}`,
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
  const lines = [`omp doctor ${report.ok ? "OK" : "FAIL"}`];
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    lines.push(`  ${icon} ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}
