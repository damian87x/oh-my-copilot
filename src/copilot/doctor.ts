import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";
import { UNAVAILABLE_SIGNATURE } from "../council/types.js";
import { readMemoryConfig } from "../memory-review/config.js";

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
  checkHooks?: boolean;
  /** Run slow, network-dependent probes (e.g. the memory-review model). Opt-in
   *  via `omp doctor --deep` so the default doctor stays fast. */
  deepCheck?: boolean;
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

// Recognized Copilot CLI hook events (camelCase native + VS Code-compatible
// PascalCase aliases). `agentStop` powers the omp loop driver.
const SUPPORTED_HOOK_EVENTS = new Set([
  "sessionStart",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "preCompact",
  "sessionEnd",
  "errorOccurred",
  "permissionRequest",
  "notification",
  // VS Code-compatible event names accepted by Copilot CLI.
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
  "ErrorOccurred",
  "PermissionRequest",
  "Notification",
]);

function describeUnsupportedEvent(eventName: string): string {
  if (eventName === "Error") return 'unsupported hook event "Error" (use errorOccurred or ErrorOccurred)';
  return `unsupported hook event "${eventName}"`;
}

function validateHookEntry(eventName: string, entry: unknown, index: number): string[] {
  const issues: string[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${eventName}[${index}] must be an object`];
  }
  const record = entry as Record<string, unknown>;
  const type = record.type ?? "command";
  if (type === "command") {
    if (
      typeof record.bash !== "string" &&
      typeof record.powershell !== "string" &&
      typeof record.command !== "string"
    ) {
      issues.push(`${eventName}[${index}] command hook needs bash, powershell, or command`);
    }
  } else if (type === "http") {
    if (typeof record.url !== "string") issues.push(`${eventName}[${index}] http hook needs url`);
  } else if (type === "prompt") {
    if (eventName !== "sessionStart" && eventName !== "SessionStart") {
      issues.push(`${eventName}[${index}] prompt hooks are only supported on sessionStart`);
    }
    if (typeof record.prompt !== "string") issues.push(`${eventName}[${index}] prompt hook needs prompt`);
  } else {
    issues.push(`${eventName}[${index}] has unsupported hook type "${String(type)}"`);
  }
  return issues;
}

function validateHooksManifestShape(manifest: unknown): string[] {
  const issues: string[] = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest must be a JSON object with version: 1 and hooks"];
  }
  const record = manifest as Record<string, unknown>;
  if (record.version !== 1) issues.push("manifest must declare version: 1");
  if (!record.hooks || typeof record.hooks !== "object" || Array.isArray(record.hooks)) {
    issues.push("manifest must declare a hooks object");
    return issues;
  }
  for (const [eventName, entries] of Object.entries(record.hooks as Record<string, unknown>)) {
    if (!SUPPORTED_HOOK_EVENTS.has(eventName)) issues.push(describeUnsupportedEvent(eventName));
    if (!Array.isArray(entries)) {
      issues.push(`${eventName} must be an array of hook entries`);
      continue;
    }
    entries.forEach((entry, index) => issues.push(...validateHookEntry(eventName, entry, index)));
  }
  return issues;
}

function sampleHookPayload(eventName: string, cwd: string): Record<string, unknown> {
  switch (eventName) {
    case "UserPromptSubmit":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, prompt: "doctor smoke" };
    case "PreToolUse":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, tool_name: "view", tool_input: { path: "README.md" } };
    case "PostToolUse":
      return {
        hook_event_name: eventName,
        session_id: "doctor-smoke",
        timestamp: new Date().toISOString(),
        cwd,
        tool_name: "view",
        tool_input: { path: "README.md" },
        tool_result: { result_type: "success", text_result_for_llm: "doctor smoke" },
      };
    case "PostToolUseFailure":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, tool_name: "edit", tool_input: {}, error: "doctor smoke" };
    case "Stop":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, transcript_path: "", stop_reason: "end_turn" };
    case "SubagentStart":
    case "SubagentStop":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, transcript_path: "", agent_name: "doctor" };
    case "PreCompact":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, transcript_path: "", trigger: "manual", custom_instructions: "" };
    case "SessionStart":
    case "SessionEnd":
    case "ErrorOccurred":
    case "PermissionRequest":
    case "Notification":
      return { hook_event_name: eventName, session_id: "doctor-smoke", timestamp: new Date().toISOString(), cwd, error: "doctor smoke", message: "doctor smoke" };
    default:
      return {
        sessionId: "doctor-smoke",
        timestamp: Date.now(),
        cwd,
        prompt: "doctor smoke",
        toolName: "view",
        toolArgs: { path: "README.md" },
        toolResult: { resultType: "success", textResultForLlm: "doctor smoke" },
        error: "doctor smoke",
        transcriptPath: "",
        stopReason: "end_turn",
        trigger: "manual",
        customInstructions: "",
      };
  }
}

function commandForSmoke(entry: Record<string, unknown>): string | undefined {
  const platformPreference = process.platform === "win32"
    ? [entry.powershell, entry.command, entry.bash]
    : [entry.bash, entry.command, entry.powershell];
  const command = platformPreference.find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return command;
}

function timeoutMsForSmoke(entry: Record<string, unknown>): number {
  const timeout = typeof entry.timeoutSec === "number" ? entry.timeoutSec : typeof entry.timeout === "number" ? entry.timeout : 10;
  return Math.max(1, timeout) * 1000;
}

function checkHooksSmoke(paths: CopilotPaths): DoctorCheck {
  if (!existsSync(paths.hooksManifest)) {
    return { name: "hooks-smoke", status: "warn", detail: `skipped; no hooks manifest: ${paths.hooksManifest}` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(paths.hooksManifest, "utf8")) as unknown;
  } catch (error) {
    return { name: "hooks-smoke", status: "fail", detail: `skipped; invalid hooks JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const schemaIssues = validateHooksManifestShape(manifest);
  if (schemaIssues.length > 0) {
    return { name: "hooks-smoke", status: "fail", detail: `skipped; hooks schema invalid: ${schemaIssues.join("; ")}` };
  }

  const hooks = (manifest as { hooks: Record<string, unknown[]> }).hooks;
  const smokeCwd = mkdtempSync(join(tmpdir(), "omp-hooks-smoke-"));
  const issues: string[] = [];
  let ran = 0;
  for (const [eventName, entries] of Object.entries(hooks)) {
    for (const [index, entry] of entries.entries()) {
      const record = entry as Record<string, unknown>;
      const type = record.type ?? "command";
      if (type !== "command") continue;
      const command = commandForSmoke(record);
      if (!command) {
        issues.push(`${eventName}[${index}] has no runnable command`);
        continue;
      }
      ran += 1;
      const result = spawnSync(command, {
        cwd: smokeCwd,
        env: { ...process.env, OMP_PLUGIN_ROOT: paths.pluginRoot, OMC_PLUGIN_ROOT: paths.pluginRoot },
        input: JSON.stringify(sampleHookPayload(eventName, smokeCwd)),
        encoding: "utf8",
        shell: true,
        timeout: timeoutMsForSmoke(record),
      });
      if (result.error) {
        issues.push(`${eventName}[${index}] failed: ${result.error.message}`);
        continue;
      }
      if (result.status !== 0) {
        issues.push(`${eventName}[${index}] exited ${result.status ?? "?"}: ${(result.stderr || result.stdout).trim()}`);
        continue;
      }
      const stdout = (result.stdout ?? "").trim();
      if (!stdout) continue;
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          issues.push(`${eventName}[${index}] stdout JSON must be an object`);
          continue;
        }
        // Hooks dual-emit Copilot v1 keys AND Claude Code keys (continue /
        // hookSpecificOutput); both vocabularies are valid here.
      } catch {
        issues.push(`${eventName}[${index}] invalid stdout JSON: ${stdout.slice(0, 120)}`);
      }
    }
  }
  if (issues.length > 0) return { name: "hooks-smoke", status: "fail", detail: issues.join("; ") };
  return { name: "hooks-smoke", status: "pass", detail: `ran ${ran} command hook${ran === 1 ? "" : "s"} with documented sample payloads` };
}

function checkHooksManifest(paths: CopilotPaths): DoctorCheck {
  if (!existsSync(paths.hooksManifest)) {
    return {
      name: "hooks-manifest",
      status: "warn",
      detail: `not present: ${paths.hooksManifest}`,
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(paths.hooksManifest, "utf8")) as unknown;
    const issues = validateHooksManifestShape(manifest);
    if (issues.length > 0) {
      return { name: "hooks-manifest", status: "fail", detail: `${paths.hooksManifest}: ${issues.join("; ")}` };
    }
  } catch (error) {
    return {
      name: "hooks-manifest",
      status: "fail",
      detail: `${paths.hooksManifest}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { name: "hooks-manifest", status: "pass", detail: paths.hooksManifest };
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

/** Pure classifier for a memory-review model probe (kept separate so it's
 *  testable without spawning copilot). Mirrors copilot/models.probeModel: a
 *  working model is proven by captured stdout, because `copilot -p` often prints
 *  its reply but doesn't exit (so spawnSync reports a SIGTERM/timeout, not 0). */
export function classifyMemoryReviewProbe(
  slug: string,
  outcome: { status: number | null; stdout: string; stderr: string; errorCode?: string },
): DoctorCheck {
  const name = "memory-review-model";
  if (outcome.stdout.trim().length > 0 || outcome.status === 0) {
    return { name, status: "pass", detail: `${slug} ok` };
  }
  if (UNAVAILABLE_SIGNATURE.test(outcome.stderr)) {
    return {
      name,
      status: "warn",
      detail: `model '${slug}' not available — run: omp config set memory-review-model <slug>`,
    };
  }
  if (outcome.errorCode === "ENOENT") {
    return { name, status: "warn", detail: "copilot not found on PATH" };
  }
  return { name, status: "warn", detail: `probe failed (exit=${outcome.status ?? "timeout"})` };
}

function checkMemoryReviewModel(cwd: string | undefined, bin: string): DoctorCheck {
  const cfg = readMemoryConfig(cwd ?? process.cwd());
  if (cfg.memoryMode !== "on") {
    return { name: "memory-review-model", status: "pass", detail: "memory-mode off (skipped)" };
  }
  const slug = cfg.memoryReviewModel;
  const result = spawnSync(bin, ["--model", slug, "-p", "Reply with: ok"], {
    encoding: "utf8",
    timeout: 15000,
  });
  return classifyMemoryReviewProbe(slug, {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  });
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
  if (options.checkHooks) {
    checks.push(checkHooksSmoke(paths));
  }
  if (!options.skipCopilot) {
    checks.push(checkCopilotCli(options.copilotBin ?? "copilot"));
    if (options.deepCheck) {
      checks.push(checkMemoryReviewModel(options.cwd, options.copilotBin ?? "copilot"));
    }
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
