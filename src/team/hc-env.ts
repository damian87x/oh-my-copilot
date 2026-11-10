import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * herdr-core (`hc`) terminals inherit the environment of whoever auto-started
 * the hc core, NOT the caller's. So PATH, BYOK (`COPILOT_*`) and GitHub auth
 * must be handed over explicitly. Secrets never go into argv (world-readable
 * via `ps`): they are written to a 0600 env file that the worker sources and
 * deletes on start.
 */

/** Fixed keys forwarded from the caller (unset in the worker when absent). */
export const HC_ENV_FIXED_KEYS = [
  "PATH",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GH_HOST",
] as const;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SWEEP_AGE_MS = 60 * 60 * 1000;

/** `sh` script run by the worker: source the env file, delete it, exec the agent. */
export const HC_LAUNCH_SCRIPT = 'f=$1; shift; set -a; . "$f"; set +a; rm -f "$f"; exec "$@"';

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function defaultHcEnvDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.OMP_HOME_OVERRIDE || homedir();
  return join(home, ".omp", "hc-env");
}

/** Render the env file body (pure; exported for tests). */
export function renderHcEnvFile(
  env: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): string {
  const lines: string[] = [
    "# omp → hc worker env (sourced once, then deleted)",
    // Drop COPILOT_* the core may have inherited at its own start; the caller's
    // values (if any) are re-set below.
    "for v in $(env | sed -n 's/^\\(COPILOT_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
  ];
  const set = new Map<string, string>();
  for (const key of HC_ENV_FIXED_KEYS) {
    const value = env[key];
    if (value === undefined) lines.push(`unset ${key}`);
    else set.set(key, value);
  }
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("COPILOT_")) continue;
    const value = env[key];
    if (value !== undefined) set.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) set.set(key, value);
  for (const [key, value] of set) {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid env key: ${JSON.stringify(key)}`);
    lines.push(`${key}=${shellQuote(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Delete leftover env files older than one hour (workers that never started). */
export function sweepHcEnvDir(dir: string, now: number = Date.now()): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".env")) continue;
    const file = join(dir, entry);
    try {
      if (now - statSync(file).mtimeMs > SWEEP_AGE_MS) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      // raced with the worker deleting it — fine
    }
  }
  return removed;
}

export interface WriteHcEnvOptions {
  env?: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
  dir?: string;
  label?: string;
  now?: number;
}

/** Write a private (0600, dir 0700) env file and return its absolute path. */
export function writeHcEnvFile(opts: WriteHcEnvOptions = {}): string {
  const env = opts.env ?? process.env;
  const dir = resolve(opts.dir ?? defaultHcEnvDir(env));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  sweepHcEnvDir(dir, opts.now);
  const safeLabel = (opts.label ?? "worker").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const file = join(dir, `${safeLabel}-${randomUUID()}.env`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, renderHcEnvFile(env, opts.extra));
  } finally {
    closeSync(fd);
  }
  chmodSync(file, 0o600);
  return file;
}

/** argv for `hc run ... -- <argv>`: no secret values, absolute agent binary. */
export function hcLaunchArgv(envFile: string, absBin: string, args: string[] = []): string[] {
  if (!isAbsolute(envFile)) throw new Error("env file path must be absolute");
  if (!isAbsolute(absBin)) throw new Error("agent binary path must be absolute");
  return ["/bin/sh", "-c", HC_LAUNCH_SCRIPT, "omp-env", envFile, absBin, ...args];
}

/** Resolve a command to an absolute executable path using the caller's PATH. */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (command.includes("/")) {
    const abs = resolve(command);
    return isExecutable(abs) ? abs : undefined;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
