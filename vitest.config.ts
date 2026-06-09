import { defineConfig } from "vitest/config";

// One global setup file makes the OMP_SKIP_USER_ENV opt-out apply to every
// test, so runCli() can never silently pick up the developer's ~/.omp/.env
// during a test run.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
