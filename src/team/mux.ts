import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "./hc-env.js";

/**
 * Which terminal backend runs agent panes: herdr-core (`hc`, default) or tmux.
 *
 * Precedence:
 *   1. OMP_MUX=herdr|tmux
 *   2. <copilot home>/omp.json  { "mux": "herdr" | "tmux" }   (COPILOT_HOME or ~/.copilot)
 *   3. auto: inside hc or HERDR_ENV=1 ⇒ herdr; inside tmux ⇒ tmux; otherwise herdr
 *   4. herdr selected but hc missing ⇒ tmux, with a one-line notice
 *      (`/team` inside HERDR_ENV=1 uses the herdr CLI instead; see team-launch.sh)
 */
export type MuxKind = "tmux" | "herdr";

export interface MuxSelection {
  kind: MuxKind;
  source: "env" | "config" | "auto";
  notice?: string;
  warning?: string;
}

export interface ResolveMuxOptions {
  env?: NodeJS.ProcessEnv;
  hcAvailable?: () => boolean;
  readConfig?: (path: string) => string | undefined;
}

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), ".copilot");
}

export function muxConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(copilotHome(env), "omp.json");
}

function isMuxKind(value: unknown): value is MuxKind {
  return value === "herdr" || value === "tmux";
}

function defaultReadConfig(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Read `mux` from omp.json. Missing file ⇒ {}; malformed ⇒ warning. */
export function readMuxConfig(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: (path: string) => string | undefined = defaultReadConfig,
): { mux?: MuxKind; warning?: string } {
  const path = muxConfigPath(env);
  const raw = readConfig(path);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { mux?: unknown };
    if (parsed && typeof parsed === "object" && parsed.mux !== undefined) {
      if (isMuxKind(parsed.mux)) return { mux: parsed.mux };
      return { warning: `${path}: "mux" must be "herdr" or "tmux"; using auto` };
    }
    return {};
  } catch {
    return { warning: `${path}: invalid JSON; using auto` };
  }
}

export function resolveMux(opts: ResolveMuxOptions = {}): MuxSelection {
  const env = opts.env ?? process.env;
  const hcAvailable = opts.hcAvailable ?? (() => resolveHcBin(env) !== undefined);
  let kind: MuxKind;
  let source: MuxSelection["source"];
  let warning: string | undefined;

  const fromEnv = env.OMP_MUX?.trim().toLowerCase();
  if (isMuxKind(fromEnv)) {
    kind = fromEnv;
    source = "env";
  } else {
    if (fromEnv) warning = `OMP_MUX=${env.OMP_MUX} is not herdr|tmux; ignoring`;
    const config = readMuxConfig(env, opts.readConfig);
    if (config.warning) warning = config.warning;
    if (config.mux) {
      kind = config.mux;
      source = "config";
    } else {
      source = "auto";
      kind = env.HC_TERMINAL_ID || env.HERDR_ENV === "1" ? "herdr" : env.TMUX ? "tmux" : "herdr";
    }
  }

  if (kind === "herdr" && !hcAvailable()) {
    // Silent for auto (most people simply don't have hc); loud when herdr was asked for.
    const notice =
      source === "auto"
        ? undefined
        : `hc not found; using tmux. Install: https://herdr.dev or set "mux":"tmux" in ${muxConfigPath(env)}`;
    return { kind: "tmux", source, ...(warning ? { warning } : {}), ...(notice ? { notice } : {}) };
  }
  return { kind, source, ...(warning ? { warning } : {}) };
}

/**
 * Locate the herdr-core CLI. The installer adds `herdr-core` and symlinks `hc`
 * only if no other `hc` exists, so `hc` is verified by its `--version` banner.
 * OMP_HC_BIN (absolute path) overrides discovery.
 */
export function resolveHcBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OMP_HC_BIN) return resolveExecutable(env.OMP_HC_BIN, env);
  const hc = resolveExecutable("hc", env);
  if (hc && isHerdrCore(hc)) return hc;
  return resolveExecutable("herdr-core", env);
}

function isHerdrCore(bin: string): boolean {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
  return r.status === 0 && /^hc\s/.test(r.stdout ?? "");
}
