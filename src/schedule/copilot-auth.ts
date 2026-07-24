/**
 * Auth pre-flight for unattended scheduled Copilot runs.
 *
 * A scheduled job fires under cron/launchd/systemd with no TTY and no access
 * to the OS keychain, so neither the Copilot CLI nor `gh` can pull credentials
 * the interactive way — the run dies with "No authentication information
 * found". The fix is a token in the environment; omp auto-loads `~/.omp/.env`
 * on every CLI invocation (src/cli.ts, src/env/dotenv.ts), so a token there is
 * enough. This check looks at process.env first and then parses the file
 * directly, so it also works when the caller skipped env loading
 * (OMP_SKIP_USER_ENV).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OMP_ENV_DIRNAME, OMP_ENV_FILENAME, parseDotEnv } from "../env/dotenv.js";

/** Env keys that authenticate Copilot CLI (`COPILOT_GITHUB_TOKEN`) or `gh` (any). */
export const COPILOT_AUTH_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * True when a Copilot/gh auth token is available to an unattended run: present
 * in `env` (default process.env) or in `<homeDir>/.omp/.env` (default the real
 * home). Fails open to `false` (caller only warns) and never throws.
 */
export function copilotAuthConfigured(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): boolean {
  if (COPILOT_AUTH_KEYS.some((k) => env[k])) return true;
  const envPath = join(homeDir, OMP_ENV_DIRNAME, OMP_ENV_FILENAME);
  if (!existsSync(envPath)) return false;
  try {
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    return COPILOT_AUTH_KEYS.some((k) => Boolean(parsed[k]));
  } catch {
    return false; // unreadable file — treat as unconfigured, the warning says what to do
  }
}
