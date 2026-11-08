import { makeTmux, type TmuxApi } from "../team/tmux.js";
import { makeHerdr } from "../team/herdr.js";
import { resolveMux } from "../team/mux.js";

/** Route existing sessions by ownership, not today's launch preference. */
export function makeCommsMux(env: NodeJS.ProcessEnv = process.env, session?: string): TmuxApi {
  const preferredHerdr = resolveMux({ env }).kind === "herdr";
  const preferred = preferredHerdr ? makeHerdr({ env }) : makeTmux();
  if (!session || preferred.sessionExists(session)) return preferred;
  const other = preferredHerdr ? makeTmux() : makeHerdr({ env });
  return other.sessionExists(session) ? other : preferred;
}

/**
 * Regex matching a Copilot session name produced by the launch scheme
 * (`omp-${Date.now()}`). Naturally excludes `omp-team-*` and any other
 * non-digit suffixes.
 */
export const COPILOT_SESSION_RE = /^omp-\d+$/;

export type ResolveSessionSuccess = {
  ok: true;
  session: string;
  source: "flag" | "env" | "discovery";
};

export type ResolveSessionFailure = {
  ok: false;
  error: string;
  candidates?: string[];
};

export type ResolveSessionResult = ResolveSessionSuccess | ResolveSessionFailure;

export interface ResolveSessionOpts {
  /** Value of the --session CLI flag, if provided. */
  flag?: string;
  /** Value of the COPILOT_TMUX_SESSION env var, if set. */
  env?: string;
  /** Injected tmux API (defaults to the real one). */
  tmux?: TmuxApi;
}

/**
 * Resolve the target Copilot session via three-tier precedence:
 * 1. Explicit --session flag
 * 2. COPILOT_SESSION / COPILOT_TMUX_SESSION env var
 * 3. Auto-discovery across tmux and herdr for exactly one launcher session
 *
 * Returns a structured result — never throws.
 */
export function resolveSession(opts: ResolveSessionOpts = {}): ResolveSessionResult {
  const { flag, env } = opts;
  if (flag && flag.length > 0) {
    return { ok: true, session: flag, source: "flag" };
  }

  if (env && env.length > 0) {
    return { ok: true, session: env, source: "env" };
  }

  let sessions: string[];
  try {
    sessions = opts.tmux
      ? opts.tmux.listSessions()
      : [...makeTmux().listSessions(), ...makeHerdr().listSessions()];
  } catch (err) {
    // Honor the no-throw contract: surface tmux failures as a structured result.
    return {
      ok: false,
      error: `failed to list ${opts.tmux ? "tmux" : "tmux/herdr"} sessions (${err instanceof Error ? err.message : String(err)}) — pass --session <name>`,
    };
  }
  const candidates = sessions.filter((name) => COPILOT_SESSION_RE.test(name));

  if (candidates.length === 1) {
    return { ok: true, session: candidates[0]!, source: "discovery" };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "no running copilot session found — launch with `omp`, or pass --session <name>",
    };
  }

  // More than one match — refuse to pick silently.
  return {
    ok: false,
    error: `multiple copilot sessions found — pass --session <name> to specify one:\n  ${candidates.join("\n  ")}`,
    candidates,
  };
}
