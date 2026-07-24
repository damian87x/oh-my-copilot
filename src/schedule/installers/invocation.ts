import { realpathSync } from "node:fs";

/**
 * Real path of the running CLI script (dist .js). OS schedulers invoke the
 * entry with a minimal PATH, so a symlinked wrapper is resolved to its target
 * here — the target's own path is what gets written into the entry.
 */
function cliScriptPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) return "omp";
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

/**
 * argv for an OS-scheduler entry that runs `omp schedule run --id <id> --root <stateRoot>`.
 *
 * cron/launchd/systemd run with a minimal PATH (`/usr/bin:/bin`) where the
 * `#!/usr/bin/env node` shebang of the omp wrapper cannot resolve `node`
 * (e.g. nvm installs) — the tick then dies with `env: node: No such file or
 * directory`. So unless the user supplied their own wrapper via `OMP_BIN`
 * (they own its environment), invoke the current node executable and the real
 * CLI script explicitly.
 */
export function scheduleRunArgv(jobId: string, stateRoot: string): string[] {
  const ompBin = process.env.OMP_BIN;
  const head = ompBin ? [ompBin] : [process.execPath, cliScriptPath()];
  return [...head, "schedule", "run", "--id", jobId, "--root", stateRoot];
}
