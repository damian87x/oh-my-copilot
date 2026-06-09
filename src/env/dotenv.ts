/**
 * Tiny dotenv reader for the omp CLI. Two purposes:
 *
 *  1. {@link parseDotEnv} — pure string → record parser. Same rules the legacy
 *     `loadDotEnv` in src/jira.ts:100-117 has used in production. Shared here
 *     so jira and the new `~/.omp/.env` loader stay in sync.
 *
 *  2. {@link loadOmpEnv} — auto-loads `~/.omp/.env` into `process.env` so the
 *     CLI works from any cwd without needing `set -a; source .env; set +a`.
 *     Precedence: shell `process.env` always wins; the file only fills in
 *     keys that are not already set, so CI environments and one-off
 *     `KEY=value omp ...` invocations are unaffected.
 *
 *  Both functions are designed to fail open — a missing or unreadable file
 *  must never crash the CLI; we degrade silently (loadOmpEnv) or emit a
 *  one-line stderr warning, never the file contents.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OMP_ENV_DIRNAME = ".omp";
export const OMP_ENV_FILENAME = ".env";

/**
 * Parse the text of a `.env` file. Accepted syntax (a deliberate subset, the
 * same rules src/jira.ts already follows):
 *
 *   KEY=value            → { KEY: "value" }
 *   KEY="quoted value"   → { KEY: "quoted value" }   (single OR double quotes; matching outer pair stripped)
 *   KEY=value with spaces → { KEY: "value with spaces" }
 *   # comment            → ignored
 *   (blank line)         → ignored
 *   malformed (no `=`)   → skipped (no throw)
 *   KEY=                 → empty string → caller decides whether to apply
 *
 * NOT supported (out of scope for `omp`): `export KEY=`, `${VAR}` interpolation,
 * multi-line values, escape sequences. Keep this tiny.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!key) continue;
    // Strip a leading/trailing quote independently — preserves the legacy
    // src/jira.ts loadDotEnv behavior verbatim so any existing .env files
    // that jira used keep producing the same map.
    const value = line
      .slice(equals + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

export interface LoadOmpEnvOptions {
  /** Override the user's home directory. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Target process.env-like map. Defaults to the real process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Where to send diagnostic warnings. Defaults to console.error (stderr). */
  log?: (msg: string) => void;
}

export interface LoadOmpEnvResult {
  /** Number of keys actually applied to processEnv (skipped keys do not count). */
  loaded: number;
  /** Resolved file path that was read, or null when no file exists. */
  path: string | null;
}

/**
 * Locate `<home>/.omp/.env`, parse it, and apply non-conflicting keys onto
 * `processEnv`. Keys already present in `processEnv` (incl. empty strings) are
 * preserved — shell environment always wins.
 *
 * Returns a summary so the caller can log "loaded N keys from <path>" once at
 * startup if desired. We do NOT log secret values; only the path and counts.
 */
export function loadOmpEnv(opts: LoadOmpEnvOptions = {}): LoadOmpEnvResult {
  const home = opts.homeDir ?? homedir();
  const env = opts.processEnv ?? process.env;
  const log = opts.log ?? ((m) => console.error(m));

  // Test escape hatch — OMP_SKIP_USER_ENV=1 in the target env disables the
  // loader. Real CLI calls inherit process.env by default, so a single
  // vitest setup line (process.env.OMP_SKIP_USER_ENV="1") opts the entire
  // suite out. Unit tests that DO want to exercise the loader pass their
  // own clean processEnv and don't inherit the flag.
  if (env.OMP_SKIP_USER_ENV) {
    return { loaded: 0, path: null };
  }

  const path = join(home, OMP_ENV_DIRNAME, OMP_ENV_FILENAME);

  if (!existsSync(path)) return { loaded: 0, path: null };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // Permissions error, racing delete — degrade gracefully. Don't leak path
    // contents; just say we couldn't read it.
    const msg = err instanceof Error ? err.message : String(err);
    log(`omp: could not read ${path}: ${msg}`);
    return { loaded: 0, path };
  }

  const parsed = parseDotEnv(text);
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    // Skip empty values — treat `KEY=` in the file as "no opinion", so an
    // empty file entry can't accidentally shadow a process.env value the
    // user later sets in a parent shell.
    if (value === "") continue;
    // process.env wins — only fill the gap.
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded++;
  }
  return { loaded, path };
}
