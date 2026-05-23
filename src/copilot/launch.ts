import { spawn } from "node:child_process";

export interface LaunchOptions {
  args: string[];
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LaunchResult {
  ok: boolean;
  exitCode: number;
  bin: string;
}

export function resolveCopilotBin(override?: string): string {
  if (override && override.length > 0) return override;
  const fromEnv = process.env.OMP_COPILOT_BIN ?? process.env.OMC_COPILOT_BIN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return "copilot";
}

export async function launchCopilot(options: LaunchOptions): Promise<LaunchResult> {
  const bin = resolveCopilotBin(options.bin);
  return new Promise<LaunchResult>((resolveFn) => {
    let settled = false;
    const child = spawn(bin, options.args, {
      stdio: "inherit",
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolveFn({ ok: false, exitCode: 127, bin });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const exitCode = typeof code === "number" ? code : 1;
      resolveFn({ ok: exitCode === 0, exitCode, bin });
    });
  });
}
