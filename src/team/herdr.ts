import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hcLaunchArgv, resolveExecutable, writeHcEnvFile } from "./hc-env.js";
import { resolveHcBin } from "./mux.js";
import { promptStillBuffered, type TmuxApi, type TmuxResult } from "./tmux.js";

/**
 * herdr-core (`hc`) backend. Implements the TmuxApi contract the team code
 * already uses, plus a native `submit` (hc pastes + Enter in one call) and
 * `spawnWorker`. Routing is pinned per team (TeamConfig.mux / manifest lane mux),
 * so a herdr client never receives tmux pane ids and vice versa.
 */

export interface HcResult extends TmuxResult {
  timedOut?: boolean;
}

export type HcRunner = (args: string[], timeoutMs: number) => HcResult;

/** hc address (`t7`, `t1b`). */
export const HC_ADDRESS_RE = /^t\d+[a-z]?$/;
const HC_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export const HC_TIMEOUT_MS = {
  default: 10_000,
  run: 30_000,
  warmup: 30_000,
  // `hc send`/`keys` wait for typing quiet and protect a person's draft (up to 180 s).
  input: 200_000,
} as const;

export function validHcName(name: string): boolean {
  return HC_NAME_RE.test(name) && !HC_ADDRESS_RE.test(name);
}

/** Project-scoped, hc-valid group name shared with team-launch.sh. */
export function hcGroupName(teamName: string, cwd: string = process.cwd()): string {
  return `omp-${createHash("sha256").update(`${realpathSync(cwd)}\0${teamName}`).digest("hex").slice(0, 12)}`;
}

export function hcWorkerName(group: string, index1: number): string {
  const name = `${group}-w${index1}`;
  if (!validHcName(name)) throw new Error(`invalid hc terminal name: ${name}`);
  return name;
}

export function hcExec(bin: string): HcRunner {
  return (args, timeoutMs) => {
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: timeoutMs,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const stderr = [r.stderr ?? "", r.error?.message ?? ""].filter(Boolean).join("\n");
    return { stdout: r.stdout ?? "", stderr, status: r.status ?? 1, timedOut };
  };
}

/** Map tmux key names to hc key names. */
export function hcKeyName(key: string): string {
  const k = key.trim();
  if (k === "C-m" || k === "Enter" || k === "enter") return "enter";
  if (k === "Escape" || k === "Esc") return "esc";
  const ctrl = /^C-(.)$/.exec(k);
  if (ctrl) return `ctrl+${ctrl[1]!.toLowerCase()}`;
  return k.toLowerCase();
}

/** Last `lines` lines of an hc read (which returns the whole screen + history). */
export function lastLines(text: string, lines: number): string {
  const all = text.replace(/\s+$/, "").split("\n");
  return `${all.slice(-Math.max(1, lines)).join("\n")}\n`;
}

function errorKind(r: TmuxResult): string | undefined {
  try {
    const parsed = JSON.parse(r.stderr || r.stdout) as { error?: { kind?: string } };
    return parsed.error?.kind;
  } catch {
    return undefined;
  }
}

export interface SpawnWorkerOptions {
  name: string;
  cwd: string;
  /** Agent command; argv[0] is resolved to an absolute path with the caller's PATH. */
  argv: string[];
  labels?: Record<string, string>;
  extraEnv?: Record<string, string>;
  /** Keep the hc parent link (lanes show as sub-agents in the caller's Herdr tab). */
  keepParent?: boolean;
}

export type SpawnWorkerResult =
  | { ok: true; address: string; name: string }
  | { ok: false; error: string };

export interface HerdrApi extends TmuxApi {
  kind: "herdr";
  submit(target: string, text: string): Promise<boolean>;
  spawnWorker(opts: SpawnWorkerOptions): SpawnWorkerResult;
  /** "unknown" when the core is unreachable or the call timed out — never "dead". */
  alive(target: string): "alive" | "dead" | "unknown";
  /** Kill and remove live terminals named `<group>-*`; returns how many. */
  closeGroup(group: string): number;
}

export interface MakeHerdrOptions {
  runner?: HcRunner;
  env?: NodeJS.ProcessEnv;
  envDir?: string;
}

function unsupported(what: string): TmuxResult {
  return { stdout: "", stderr: `${what} is not supported on herdr`, status: 1 };
}

export function makeHerdr(opts: MakeHerdrOptions = {}): HerdrApi {
  const env = opts.env ?? process.env;
  // Resolve hc lazily: a missing binary must degrade to "unknown"/errors per call
  // (collect/status keep working), never throw at construction.
  let resolved: HcRunner | undefined;
  const runner: HcRunner =
    opts.runner ??
    ((args, timeoutMs) => {
      if (!resolved) {
        const bin = resolveHcBin(env);
        if (!bin) {
          return { stdout: "", stderr: "hc (herdr-core) not found; install from https://herdr.dev or set OMP_MUX=tmux", status: 127 };
        }
        resolved = hcExec(bin);
      }
      return resolved(args, timeoutMs);
    });
  const run = (args: string[], timeoutMs: number = HC_TIMEOUT_MS.default) => runner(args, timeoutMs);
  let warmed = false;

  const liveTerminals = (): { address: string; name?: string }[] => {
    const r = run(["ls", "--json"]);
    if (r.status !== 0) return [];
    try {
      const parsed = JSON.parse(r.stdout) as { terminals?: { address?: unknown; name?: unknown }[] };
      return (parsed.terminals ?? [])
        .filter((t) => typeof t.address === "string")
        .map((t) => ({ address: t.address as string, name: typeof t.name === "string" ? t.name : undefined }));
    } catch {
      return [];
    }
  };

  const alive = (target: string): "alive" | "dead" | "unknown" => {
    const r = run(["get", target, "--json"]);
    if (r.timedOut) return "unknown";
    if (r.status === 0) {
      try {
        const state = (JSON.parse(r.stdout) as { state?: unknown }).state;
        if (state === "live") return "alive";
        if (state === "finished") return "dead";
      } catch {
        // fall through
      }
      return "unknown";
    }
    return errorKind(r) === "not_found" ? "dead" : "unknown";
  };

  const kill = (target: string): TmuxResult => {
    run(["kill", target, "--json"]);
    return run(["rm", target, "--json"]);
  };

  const api: HerdrApi = {
    kind: "herdr",
    newSession: () => unsupported("new-session"),
    splitWindow: () => unsupported("split-window"),
    sendText: () => unsupported("typing without Enter"),
    displayMessage: () => unsupported("display-message"),
    sendKeys(target, ...keys) {
      return run(["keys", target, ...keys.map(hcKeyName), "--json"], HC_TIMEOUT_MS.input);
    },
    capturePane(target, lines = 80) {
      const r = run(["read", target, "--lines", String(lines)]);
      return r.status === 0 ? { ...r, stdout: lastLines(r.stdout, lines) } : r;
    },
    killPane: kill,
    killSession(group) {
      const n = api.closeGroup(group);
      return n > 0 ? { stdout: "", stderr: "", status: 0 } : { stdout: "", stderr: `no live terminals in ${group}`, status: 1 };
    },
    paneDead(target) {
      return alive(target) === "dead";
    },
    sessionExists(group) {
      // A runtime team group (`<group>-wN`) or a single named terminal (comms: `omp-<digits>`).
      return liveTerminals().some((t) => t.name === group || t.name?.startsWith(`${group}-`));
    },
    listSessions() {
      return liveTerminals()
        .map((t) => t.name)
        .filter((n): n is string => Boolean(n));
    },
    alive,
    closeGroup(group) {
      let n = 0;
      for (const t of liveTerminals()) {
        if (t.name?.startsWith(`${group}-`) && kill(t.address).status === 0) n++;
      }
      return n;
    },
    async submit(target, text) {
      const sent = run(["send", target, text, "--json"], HC_TIMEOUT_MS.input);
      // Timeout / blocked / any error: the core may still have queued it — never resend.
      if (sent.status !== 0) return false;
      const probe = text.slice(-Math.min(20, text.length));
      const screen = api.capturePane(target, 5);
      if (screen.status === 0 && promptStillBuffered(screen.stdout, probe)) {
        run(["keys", target, "enter", "--json"], HC_TIMEOUT_MS.input);
      }
      return true;
    },
    spawnWorker(o) {
      if (!validHcName(o.name)) return { ok: false, error: `invalid hc terminal name: ${o.name}` };
      const [cmd, ...args] = o.argv;
      const absBin = cmd ? resolveExecutable(cmd, env) : undefined;
      if (!absBin) return { ok: false, error: `agent command not found on PATH: ${cmd ?? "(empty)"}` };
      if (!warmed) {
        // Start a cold core under a generous timer, not under `run`'s.
        run(["server", "status", "--json"], HC_TIMEOUT_MS.warmup);
        warmed = true;
      }
      const envFile = writeHcEnvFile({ env, extra: o.extraEnv, dir: opts.envDir, label: o.name });
      const labelArgs = Object.entries(o.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
      const r = run(
        [
          "run",
          "--bg",
          "--json",
          "--name",
          o.name,
          "--cwd",
          o.cwd,
          ...labelArgs,
          "--no-notify",
          "--outlive-parent",
          ...(o.keepParent ? [] : ["--no-parent"]),
          "--",
          ...hcLaunchArgv(envFile, absBin, args),
        ],
        HC_TIMEOUT_MS.run,
      );
      if (r.status !== 0) {
        return { ok: false, error: `hc run failed${r.timedOut ? " (timeout)" : ""}: ${(r.stderr || r.stdout).trim()}` };
      }
      try {
        const address = (JSON.parse(r.stdout) as { address?: unknown }).address;
        if (typeof address === "string" && HC_ADDRESS_RE.test(address)) return { ok: true, address, name: o.name };
      } catch {
        // fall through
      }
      return { ok: false, error: `unexpected hc run output: ${r.stdout.slice(0, 200)}` };
    },
  };
  return api;
}
