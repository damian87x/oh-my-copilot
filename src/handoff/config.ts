import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

// Handoff LLM auto-generation is off by default. Explicit `omp handoff create --llm`
// always allows one cost-bearing path; automatic (default create) LLM only when
// `handoffLlm` is "on" in config (project .omp/config.json overrides global ~/.omp).

export type HandoffLlmMode = "off" | "on";

export interface HandoffConfig {
  handoffLlm: HandoffLlmMode;
}

export interface HandoffConfigOptions {
  homeDir?: string;
  scope?: "project" | "global";
}

function projectConfigPath(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "config.json");
}

function globalConfigPath(homeDir?: string): string {
  const home = homeDir ?? (process.env.OMP_HOME_OVERRIDE || homedir());
  return join(home, ".omp", "config.json");
}

function readRawAt(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readHandoffConfig(cwd: string, opts: HandoffConfigOptions = {}): HandoffConfig {
  const raw = { ...readRawAt(globalConfigPath(opts.homeDir)), ...readRawAt(projectConfigPath(cwd)) };
  const env = process.env.OMP_HANDOFF_LLM?.trim();
  const handoffLlm: HandoffLlmMode =
    env === "on" || env === "off"
      ? env
      : raw.handoffLlm === "on"
        ? "on"
        : "off";
  return { handoffLlm };
}

/** Persist `handoffLlm` in project (default) or global config. Atomic. */
export function setHandoffLlm(
  cwd: string,
  value: HandoffLlmMode,
  opts: HandoffConfigOptions = {},
): void {
  const p = opts.scope === "global" ? globalConfigPath(opts.homeDir) : projectConfigPath(cwd);
  const raw = readRawAt(p);
  raw.handoffLlm = value;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
}
