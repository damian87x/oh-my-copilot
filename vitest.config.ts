import { configDefaults, defineConfig } from "vitest/config";

// One global setup file makes the OMP_SKIP_USER_ENV opt-out apply to every
// test, so runCli() can never silently pick up the developer's ~/.omp/.env
// during a test run.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // .worktrees/ holds nested git worktrees on other branches (gitignored, not
    // part of this package). Without this, vitest discovers their test files and
    // a stale branch can fail the suite against the current tree.
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
