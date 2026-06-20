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

function defaultCliPath() {
  // scripts/lib/ -> packageRoot/dist/src/cli.js
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "dist", "src", "cli.js");
}

export function triggerMemoryReview(options = {}) {
  const { cwd, sessionId, spawn = nodeSpawn, cliPath = defaultCliPath(), mode } = options;
  const resolvedMode = mode ?? readMemoryMode(cwd);
  if (resolvedMode !== "on") return { triggered: false, reason: "memory-mode off" };
  if (!sessionId || sessionId === "unknown") return { triggered: false, reason: "no session id" };
  try {
    const child = spawn(
      process.execPath,
      [cliPath, "memory-review", "--session", sessionId, "--root", cwd],
      { detached: true, stdio: "ignore" },
    );
    // Handle async spawn errors so they never surface as unhandled (fail-open).
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
    return { triggered: true };
  } catch (err) {
    return { triggered: false, reason: String(err?.message ?? err) };
  }
}
