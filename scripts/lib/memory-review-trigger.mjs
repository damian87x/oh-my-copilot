import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// sessionEnd hook → end-of-session memory review. The hook must return fast
// (5s timeout), so this only DETACHES `omp memory-review` and returns. The
// downstream claim guard de-dupes against the wrapper fallback. Fail-open:
// any error means "don't trigger", never throw into the hook.

function readMemoryMode(cwd) {
  const env = process.env.OMP_MEMORY_MODE;
  if (env === "on") return "on";
  if (env === "off") return "off";
  try {
    const p = join(ompRoot(cwd), ".omp", "config.json");
    if (!existsSync(p)) return "off";
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return raw && raw.memoryMode === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

function defaultDistPath() {
  // scripts/lib/ -> packageRoot/dist/src/cli.js (present in the npm package and
  // dev builds, but NOT in a plugin installed from GitHub — dist is gitignored).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "dist", "src", "cli.js");
}

/** Decide how to invoke the omp CLI. An explicit cliPath (tests/dev) or a
 *  bundled dist runs via `node <path>`; otherwise — the normal install, where
 *  the plugin (from GitHub) has no dist but `omp` is installed globally via npm —
 *  invoke `omp` from PATH. Exported for testing. */
export function resolveMemoryReviewInvocation({ sessionId, cwd, cliPath, distPath = defaultDistPath(), exists = existsSync } = {}) {
  const args = ["memory-review", "--session", sessionId, "--root", cwd];
  if (cliPath) return { command: process.execPath, args: [cliPath, ...args] };
  if (exists(distPath)) return { command: process.execPath, args: [distPath, ...args] };
  return { command: "omp", args }; // plugin-from-GitHub: rely on the global omp CLI
}

export function triggerMemoryReview(options = {}) {
  const { cwd, sessionId, spawn = nodeSpawn, cliPath, mode } = options;
  const resolvedMode = mode ?? readMemoryMode(cwd);
  if (resolvedMode !== "on") return { triggered: false, reason: "memory-mode off" };
  if (!sessionId || sessionId === "unknown") return { triggered: false, reason: "no session id" };
  try {
    const { command, args } = resolveMemoryReviewInvocation({ sessionId, cwd, cliPath });
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Handle async spawn errors so they never surface as unhandled (fail-open).
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { triggered: true };
  } catch (err) {
    return { triggered: false, reason: String(err?.message ?? err) };
  }
}
