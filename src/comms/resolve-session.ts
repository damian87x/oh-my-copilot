import { makeTmux, type TmuxApi } from "../team/tmux.js";
import { makeHerdr } from "../team/herdr.js";
import { resolveMux } from "../team/mux.js";

/**
 * Default comms client: the backend `omp` launches Copilot in (herdr-core by
 * default, tmux on opt-out). Sessions are hc terminal names on herdr and tmux
 * session names on tmux; both use the `omp-<digits>` launcher naming.
 */
export function makeCommsMux(env: NodeJS.ProcessEnv = process.env): TmuxApi {
  return resolveMux({ env }).kind === "herdr" ? makeHerdr({ env }) : makeTmux();
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
 * Resolve the target Copilot tmux session via three-tier precedence:
 * 1. Explicit --session flag
 * 2. COPILOT_TMUX_SESSION env var
 * 3. Auto-discovery: scan tmux for exactly one session matching COPILOT_SESSION_RE
 *
 * Returns a structured result — never throws.
 */
export function resolveSession(opts: ResolveSessionOpts = {}): ResolveSessionResult {
  const { flag, env } = opts;
  const tmux = opts.tmux ?? makeCommsMux();

  if (flag && flag.length > 0) {
    return { ok: true, session: flag, source: "flag" };
  }

  if (env && env.length > 0) {
    return { ok: true, session: env, source: "env" };
  }

  let sessions: string[];
  try {
    sessions = tmux.listSessions();
  } catch (err) {
    // Honor the no-throw contract: surface tmux failures as a structured result.
    return {
      ok: false,
      error: `failed to list tmux sessions (${err instanceof Error ? err.message : String(err)}) — pass --session <name>`,
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
