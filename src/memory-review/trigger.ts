import { spawn as nodeSpawn } from "node:child_process";
import { readMemoryConfig } from "./config.js";

// Wrapper fallback: headless `copilot -p` SKIPS hooks, so when omp itself
// launched copilot in headless mode we trigger the review post-exit. Like the
// hook, this only DETACHES the work (the downstream claim guard de-dupes if the
// hook also fired). It reviews an EXPLICIT session id — never a guessed
// "latest" — and skips entirely when the caller couldn't identify the session.
// Spawn is injectable so tests never launch a real process.

export interface SpawnedChild {
  unref?: () => void;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
}
export type DetachSpawn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => SpawnedChild;

export interface HeadlessTriggerOptions {
  cwd: string;
  argv: string[];
  cliPath: string;
  sessionId: string;
  spawn?: DetachSpawn;
  modeOverride?: "on" | "off";
}

const PROMPT_FLAGS = new Set(["-p", "--prompt"]);

export function isHeadless(argv: string[]): boolean {
  return argv.some((a) => PROMPT_FLAGS.has(a));
}

export function triggerHeadlessReview(
  opts: HeadlessTriggerOptions,
): { triggered: boolean; reason?: string } {
  if (!isHeadless(opts.argv)) return { triggered: false, reason: "not headless" };
  const mode = opts.modeOverride ?? readMemoryConfig(opts.cwd).memoryMode;
  if (mode !== "on") return { triggered: false, reason: "memory-mode off" };
  if (!opts.sessionId) return { triggered: false, reason: "no session id" };
  const spawn = opts.spawn ?? (nodeSpawn as unknown as DetachSpawn);
  try {
    const child = spawn(
      process.execPath,
      [opts.cliPath, "memory-review", "--session", opts.sessionId, "--root", opts.cwd],
      { detached: true, stdio: "ignore" },
    );
    // Handle async spawn errors so they never surface as unhandled (fail-open).
    child?.on?.("error", () => {});
    child?.unref?.();
    return { triggered: true };
  } catch (err) {
    return { triggered: false, reason: String((err as Error)?.message ?? err) };
  }
}
