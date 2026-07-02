import { spawn } from "node:child_process";
import { resolveCopilotBin } from "../copilot/launch.js";
import type { CouncilSpawn, SpawnRequest, SpawnResponse } from "../council/types.js";

// The review subprocess reads UNTRUSTED transcript text, so it must NOT be able
// to act. Unlike the council spawn (which passes --allow-all-tools because
// members do real work), the reviewer runs with NO tool access: its only job is
// text-in / JSON-out. This is the primary defense against a prompt-injection in
// the transcript turning into tool execution; the apply-side gating is the second.

export function createReviewSpawn(bin?: string): CouncilSpawn {
  const copilotBin = resolveCopilotBin(bin);
  return (req: SpawnRequest): Promise<SpawnResponse> =>
    new Promise<SpawnResponse>((resolveFn) => {
      // NOTE: deliberately no --allow-all-tools. In headless `-p` mode copilot
      // cannot prompt for tool permission, so tools simply do not run.
      // OMP_MEMORY_MODE=off: copilot runs lifecycle hooks even for `-p`, so
      // without this the reviewer's own session would trigger a review of
      // itself — an infinite spawn cascade. Hooks inherit this env and skip.
      const child = spawn(copilotBin, ["--model", req.model, "-p", req.prompt], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OMP_MEMORY_MODE: "off" },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, req.timeoutMs);

      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveFn({ stdout, stderr, exitCode: 127, timedOut });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveFn({
          stdout,
          stderr,
          exitCode: typeof code === "number" ? code : timedOut ? 124 : 1,
          timedOut,
        });
      });
    });
}
