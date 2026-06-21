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

/**
 * Point the global ~/.omp config dir at an isolated empty temp dir so the
 * memory-mode config layer (readMemoryConfig reads <home>/.omp/config.json by
 * default) can't pick up the developer's real ~/.omp/config.json during tests.
 * Tests that exercise the global layer set OMP_HOME_OVERRIDE to their own temp
 * dir explicitly. See src/memory-review/config.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OMP_HOME_OVERRIDE = mkdtempSync(join(tmpdir(), "omc-test-home-"));
