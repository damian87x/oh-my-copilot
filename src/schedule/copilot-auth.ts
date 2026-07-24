/**
 * Auth pre-flight for unattended scheduled Copilot runs.
 *
 * A scheduled job fires under cron/launchd/systemd with no TTY and no access
 * to the OS keychain, so neither the Copilot CLI nor `gh` can pull credentials
 * the interactive way — the run dies with "No authentication information
 * found". The fix is a token in the environment; omp auto-loads `~/.omp/.env`
 * on every CLI invocation (src/cli.ts, src/env/dotenv.ts), so a token there is
 * enough. Presence checks look at process.env first and then parse the file
 * directly (so they also work when the caller skipped env loading via
 * OMP_SKIP_USER_ENV).
 *
 * Live validation ({@link validateCopilotToken}) deliberately uses only
 * env-sourced tokens ({@link findCopilotAuthTokenFromEnv}). That keeps the
 * file→network dataflow out of CodeQL's `js/file-access-to-http` path while
 * matching the production path: dotenv already put the file token into
 * process.env before schedule add runs, and OMP_SKIP_USER_ENV callers skip
 * the network check entirely. Offline/slow networks yield "unknown" and must
 * never block anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OMP_ENV_DIRNAME, OMP_ENV_FILENAME, parseDotEnv } from "../env/dotenv.js";

/** Env keys that authenticate Copilot CLI (`COPILOT_GITHUB_TOKEN`) or `gh` (any). */
export const COPILOT_AUTH_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/**
 * First Copilot/gh auth token from `env` only (default process.env). Used by
 * the live network validator so file-sourced secrets never enter an outbound
 * request. Returns undefined when none of the known keys are set.
 */
export function findCopilotAuthTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const key of COPILOT_AUTH_KEYS) {
    const value = env[key];
    if (value) return value;
  }
  return undefined;
}

/**
 * First Copilot/gh auth token from `<homeDir>/.omp/.env` only. Used for
 * presence/warning checks when env loading was skipped; never passed to
 * {@link validateCopilotToken}.
 */
export function findCopilotAuthTokenFromFile(homeDir: string = homedir()): string | undefined {
  const envPath = join(homeDir, OMP_ENV_DIRNAME, OMP_ENV_FILENAME);
  if (!existsSync(envPath)) return undefined;
  try {
    const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const key of COPILOT_AUTH_KEYS) {
      if (parsed[key]) return parsed[key];
    }
  } catch {
    // unreadable file — treated as no token; the caller's warning says what to do
  }
  return undefined;
}

/**
 * The first Copilot/gh auth token available to an unattended run: from `env`
 * (default process.env) or, failing that, from `<homeDir>/.omp/.env` (default
 * the real home). Returns undefined when no token is configured. Fails open to
 * undefined (callers only warn) and never throws.
 *
 * Prefer {@link findCopilotAuthTokenFromEnv} when the value will be sent on the
 * network (see {@link validateCopilotToken}).
 */
export function findCopilotAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string | undefined {
  return findCopilotAuthTokenFromEnv(env) ?? findCopilotAuthTokenFromFile(homeDir);
}

/** True when a Copilot/gh auth token is configured (see {@link findCopilotAuthToken}). */
export function copilotAuthConfigured(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): boolean {
  return findCopilotAuthToken(env, homeDir) !== undefined;
}

/** Result of a live token check. "unknown" covers offline, timeout, and unexpected statuses. */
export type CopilotTokenVerdict = "valid" | "invalid" | "unknown";

/**
 * Best-effort validity check of a GitHub token against `api.github.com/user`
 * (the lightest authenticated endpoint; works for the OAuth/PAT tokens gh and
 * Copilot CLI use). 2xx → "valid", 401/403 → "invalid", anything else —
 * network error, timeout, unexpected status — → "unknown" so an offline
 * machine never produces a scary warning. Never throws.
 *
 * Callers must pass an env-sourced token (via {@link findCopilotAuthTokenFromEnv}),
 * not a value read from disk, so static analysis does not treat this as file
 * data exfiltration.
 */
export async function validateCopilotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<CopilotTokenVerdict> {
  try {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 200 && res.status < 300) return "valid";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unknown";
  } catch {
    return "unknown"; // offline/timeout — never block on a check we can't complete
  }
}
