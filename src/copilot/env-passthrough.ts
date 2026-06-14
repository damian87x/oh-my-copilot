/**
 * Build `tmux -e KEY=VALUE` arguments that forward the caller's Copilot
 * environment into a pane created by `new-session` / `split-window`.
 *
 * Why this is needed: when a tmux server is already running, `new-session` and
 * `split-window` populate a new pane from the *server's* global environment, not
 * from the environment of the process that invoked tmux. So BYOK vars
 * (`COPILOT_PROVIDER_*`, `COPILOT_MODEL`, …) set only in the launching shell are
 * dropped, and Copilot silently falls back to GitHub-hosted models — exactly the
 * failure observed when `omp` is run from a plain terminal or `omp team` spawns
 * worker panes. Forwarding them explicitly with `-e` is reliable regardless of
 * tmux server state. Requires tmux >= 3.2 (the `-e` flag).
 *
 * Keys are emitted sorted so callers/tests get deterministic output.
 */
export function copilotEnvPassthroughArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("COPILOT_")) continue;
    const value = env[key];
    if (value === undefined) continue;
    args.push("-e", `${key}=${value}`);
  }
  return args;
}
