/**
 * Global vitest setup. Runs once before any test file.
 *
 * Setting OMP_SKIP_USER_ENV here makes loadOmpEnv() a no-op for every runCli()
 * call, so a developer with a real ~/.omp/.env (or a CI runner with one)
 * can't accidentally leak Slack tokens into tests that intend to verify
 * missing-token behaviour. See src/env/dotenv.ts:loadOmpEnv.
 *
 * Individual tests that DO need to exercise the autoloader can call
 * loadOmpEnv directly with an injected `processEnv` — they don't have to
 * unset this var.
 */
process.env.OMP_SKIP_USER_ENV = "1";
