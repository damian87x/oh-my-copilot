import { spawn, spawnSync } from "node:child_process";

const MADMAX_FLAG = "--madmax";
const COPILOT_BYPASS_FLAG = "--yolo";

export function normalizeCopilotLaunchArgs(args: string[]): string[] {
  const sentinelIdx = args.indexOf("--");
  const pre = sentinelIdx === -1 ? args : args.slice(0, sentinelIdx);
  const tail = sentinelIdx === -1 ? [] : args.slice(sentinelIdx);

  const out: string[] = [];
  let bypassRequested = false;
  let bypassEmitted = false;

  for (const arg of pre) {
    if (arg === MADMAX_FLAG) {
      bypassRequested = true;
      continue;
    }
    if (arg === COPILOT_BYPASS_FLAG) {
      bypassRequested = true;
      if (bypassEmitted) continue;
      out.push(arg);
      bypassEmitted = true;
      continue;
    }
    out.push(arg);
  }

  if (bypassRequested && !bypassEmitted) {
    out.push(COPILOT_BYPASS_FLAG);
  }

  return [...out, ...tail];
}

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

function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 3000 });
  return r.status === 0;
}

export async function launchCopilot(options: LaunchOptions): Promise<LaunchResult> {
  const bin = resolveCopilotBin(options.bin);
  const args = normalizeCopilotLaunchArgs(options.args);
  const cwd = options.cwd ?? process.cwd();

  // If not already inside tmux and tmux is available, wrap in a tmux session
  if (!isInsideTmux() && tmuxAvailable()) {
    const sessionName = `omp-${Date.now()}`;
    const copilotCmd = [bin, ...args].map(shellEscape).join(" ");
    return new Promise<LaunchResult>((resolveFn) => {
      let settled = false;
      const child = spawn(
        "tmux",
        ["new-session", "-s", sessionName, "-c", cwd, copilotCmd],
        {
          stdio: "inherit",
          cwd,
          env: options.env ?? process.env,
        },
      );
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

  // Already inside tmux or tmux not available — launch directly
  return new Promise<LaunchResult>((resolveFn) => {
    let settled = false;
    const child = spawn(bin, args, {
      stdio: "inherit",
      cwd,
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

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
