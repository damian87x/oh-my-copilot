import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const createdPaths: string[] = [];

afterEach(() => {
  for (const target of createdPaths.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

interface LauncherHarnessOptions {
  control?: "success" | "failure" | "invalid" | "none" | "real";
  /** Provide a fake herdr-core binary (via OMP_HC_BIN). */
  hc?: boolean;
  /** Extra env (e.g. OMP_MUX, TMUX: "" to run outside tmux). */
  env?: Record<string, string>;
  /** omp.json contents under the isolated COPILOT_HOME. */
  ompJson?: string;
  monitor?: boolean;
  copiedPackage?: "matching-dist" | "version-mismatch";
  lanes?: unknown;
  session?: string;
}

function executable(pathname: string, content: string): void {
  writeFileSync(pathname, content, "utf8");
  chmodSync(pathname, 0o755);
}

function runLauncher(options: LauncherHarnessOptions = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "omc-team-launch-"));
  createdPaths.push(fixture);
  const binDir = path.join(fixture, "bin");
  const logsDir = path.join(fixture, "logs");
  const lanesFile = path.join(fixture, "lanes.json");
  const tmuxLog = path.join(logsDir, "tmux.log");
  const hcLog = path.join(logsDir, "hc.log");
  const copilotHome = path.join(fixture, "copilot-home");
  const ompHome = path.join(fixture, "omp-home");
  mkdirSync(copilotHome, { recursive: true });
  if (options.ompJson !== undefined) writeFileSync(path.join(copilotHome, "omp.json"), options.ompJson);
  const controlLog = path.join(logsDir, "control.log");
  const session = options.session ?? `issue110-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const deliveryDir = `/tmp/team-${session}`;
  createdPaths.push(
    session.includes("/")
      ? `/tmp/team-${session.split("/", 1)[0]}`
      : deliveryDir,
  );
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    lanesFile,
    `${JSON.stringify(
      options.lanes ?? [
        { id: "lane-a", name: "Lane A", prompt: "Review the fix" },
      ],
    )}\n`,
    "utf8",
  );

  executable(
    path.join(binDir, "tmux"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "$1" in
  split-window) printf '%%1\n' ;;
  capture-pane) printf '/ commands · ? help\n' ;;
  display-message) printf '/tmp/team.sock|66728|1785439051|$4|1785439000|@8|%%1|%s|0|launch-placeholder|lane-a\n' "$PWD" ;;
esac
`,
  );
  executable(
    path.join(binDir, "omp"),
    `#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then printf '{"package":"$OMP_MOCK_VERSION"}\n'; fi
`,
  );

  const fakeHc = path.join(binDir, "fake-hc");
  if (options.hc) {
    executable(
      fakeHc,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HC_LOG"
case "$1" in
  --version) echo "hc 0.1.17" ;;
  run)
    n=$(( $(grep -c '^run ' "$HC_LOG") ))
    printf '{"address":"t%s","state":"live"}\n' "$n" ;;
  read) printf '● working\n/ commands · ? help\n\n\n' ;;
  get) printf '{"state":"live"}\n' ;;
  *) printf '{}\n' ;;
esac
`,
    );
  }

  const control = path.join(binDir, "fresh-omp");
  if (options.control === "real") {
    executable(
      control,
      `#!/bin/sh
exec ${JSON.stringify(path.resolve("node_modules/.bin/tsx"))} ${JSON.stringify(path.resolve("src/cli.ts"))} "$@"
`,
    );
  }
  if (options.control === "success" || options.control === "failure") {
    executable(
      control,
      `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CONTROL_LOG"
manifest=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--manifest" ]]; then manifest="$2"; shift 2; continue; fi
  shift
done
[[ -n "$manifest" && -f "$manifest" ]] || exit 9
${options.control === "failure" ? "exit 7" : ""}
`,
    );
  }

  let script = path.resolve(".github/skills/team/scripts/team-launch.sh");
  let expectedControl = control;
  if (options.copiedPackage) {
    const packageRoot = path.join(fixture, "package");
    const scriptDir = path.join(
      packageRoot,
      ".github",
      "skills",
      "team",
      "scripts",
    );
    mkdirSync(scriptDir, { recursive: true });
    script = path.join(scriptDir, "team-launch.sh");
    copyFileSync(
      path.resolve(".github/skills/team/scripts/team-launch.sh"),
      script,
    );
    chmodSync(script, 0o755);
    writeFileSync(
      path.join(packageRoot, "plugin.json"),
      '{"version":"0.31.0"}\n',
      "utf8",
    );
    if (options.copiedPackage === "matching-dist") {
      const distDir = path.join(packageRoot, "dist", "src");
      mkdirSync(distDir, { recursive: true });
      expectedControl = path.join(distDir, "cli.js");
      executable(
        expectedControl,
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CONTROL_LOG"
`,
      );
    }
  }

  const explicitControl =
    options.control === "invalid"
      ? "relative-control-command"
      : options.control === "none" || options.copiedPackage
        ? undefined
        : control;
  const result = spawnSync(
    "bash",
    [script, "--session", session, "--lanes", lanesFile, ...(options.monitor ? [] : ["--no-monitor"])],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OMP_MUX: "",
        HC_TERMINAL_ID: "",
        OMP_HC_BIN: options.hc ? fakeHc : "",
        COPILOT_HOME: copilotHome,
        OMP_HOME_OVERRIDE: ompHome,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMUX: "/tmp/fake,1,0",
        TMUX_LOG: tmuxLog,
        HC_LOG: hcLog,
        TEAM_MAX_COMPLETION_WAIT: "20",
        CONTROL_LOG: controlLog,
        OMP_MOCK_VERSION:
          options.copiedPackage === "version-mismatch" ? "9.9.9" : "0.31.0",
        ...(explicitControl
          ? { OMP_TEAM_CONTROL_CLI: explicitControl }
          : { OMP_TEAM_CONTROL_CLI: "" }),
        TEAM_POLL_INTERVAL: "0",
        ...options.env,
      },
    },
  );

  return {
    result,
    controlLog,
    deliveryDir,
    expectedControl,
    tmuxLog,
    hcLog,
    ompHome,
    session,
  };
}

describe("team-launch.sh visual registration", () => {
  it("rejects a path-like session before creating a delivery directory or pane", () => {
    const unsafeSession = `unsafe-${process.pid}-${Date.now()}/nested`;
    const { result, deliveryDir, tmuxLog } = runLauncher({
      control: "success",
      session: unsafeSession,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid session/i);
    expect(existsSync(deliveryDir)).toBe(false);
    expect(existsSync(tmuxLog)).toBe(false);
  });

  it("rejects path-like lane ids before creating a delivery directory or pane", () => {
    const { result, deliveryDir, tmuxLog } = runLauncher({
      control: "success",
      lanes: [
        {
          id: "../escape",
          name: "Escape",
          prompt: "Do not launch",
        },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid lanes file/i);
    expect(existsSync(deliveryDir)).toBe(false);
    expect(existsSync(tmuxLog)).toBe(false);
  });

  it("tags panes, writes the manifest first, and reuses the exact control CLI", () => {
    const {
      result,
      controlLog,
      deliveryDir,
      expectedControl,
      tmuxLog,
    } = runLauncher({ control: "success" });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(controlLog, "utf8")).toContain("team register-visual");
    const tmuxCalls = readFileSync(tmuxLog, "utf8");
    expect(tmuxCalls).toContain("set-option -p -t %1 @omp_launch_uuid");
    expect(tmuxCalls).toContain("set-option -p -t %1 @omp_lane_id lane-a");
    expect(result.stdout).toContain(
      `${expectedControl} team collect --dir ${deliveryDir} --json`,
    );
  });

  it("keeps launched panes alive when registration fails", () => {
    const { result, controlLog } = runLauncher({ control: "failure" });

    expect(result.status).toBe(0);
    expect(readFileSync(controlLog, "utf8")).toContain("team register-visual");
    expect(result.stderr).toMatch(/registration failed/i);
    expect(result.stdout).toMatch(/agents launched and prompted/i);
  });

  it("rejects a relative control override without evaluating or executing it", () => {
    const { result, controlLog } = runLauncher({ control: "invalid" });

    expect(result.status).toBe(0);
    expect(existsSync(controlLog)).toBe(false);
    expect(result.stderr).toMatch(/must be an absolute executable path/i);
    expect(result.stdout).toContain("omp team collect --dir");
  });

  it("uses the package-local built CLI when no explicit override is supplied", () => {
    const { result, controlLog, deliveryDir, expectedControl } = runLauncher({
      control: "none",
      copiedPackage: "matching-dist",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(controlLog, "utf8")).toContain("team register-visual");
    expect(result.stdout).toContain(
      `${expectedControl} team collect --dir ${deliveryDir} --json`,
    );
  });

  it("skips a stale PATH omp when package versions do not match", () => {
    const { result, controlLog } = runLauncher({
      control: "none",
      copiedPackage: "version-mismatch",
    });

    expect(result.status).toBe(0);
    expect(existsSync(controlLog)).toBe(false);
    expect(result.stderr).toMatch(/does not match this package/i);
    expect(result.stdout).toContain("omp team collect --dir");
  });
});

describe("team-launch.sh on herdr", () => {
  const herdrRun = (options: LauncherHarnessOptions = {}) =>
    runLauncher({
      control: "real",
      hc: true,
      lanes: [
        { id: "lane-a", name: "Lane A", prompt: "Review the fix" },
        { id: "lane-b", name: "Lane B", prompt: "Write the tests" },
      ],
      ...options,
      env: { TMUX: "", GH_TOKEN: "ghp_launcher_secret", COPILOT_PROVIDER_API_KEY: "byok-secret", ...options.env },
    });

  it("defaults to herdr outside tmux: hc terminals, prompts, herdr manifest, zero tmux calls", async () => {
    const { result, hcLog, tmuxLog, deliveryDir, session } = herdrRun();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(tmuxLog)).toBe(false);

    const { hcGroupName } = await import("../../src/team/herdr.js");
    const group = hcGroupName(session);
    const calls = readFileSync(hcLog, "utf8").trim().split("\n");
    const runs = calls.filter((c) => c.startsWith("run "));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain(`--name ${group}-w1`);
    expect(runs[1]).toContain(`--name ${group}-w2`);
    expect(runs[0]).toContain("--no-notify --outlive-parent --no-parent");
    // argv ends with the absolute agent binary; no secret anywhere in hc's argv
    expect(runs[0]).toMatch(/omp-env \S+\.env \S+\/bin\/omp --madmax$/);
    const log = readFileSync(hcLog, "utf8");
    expect(log).not.toContain("ghp_launcher_secret");
    expect(log).not.toContain("byok-secret");

    // the env file carries the secrets + worker flags (fake hc never runs it)
    const envFile = /omp-env (\S+\.env)/.exec(runs[0]!)![1]!;
    const envBody = readFileSync(envFile, "utf8");
    expect(envBody).toContain("OMP_TEAM_WORKER='1'");
    expect(envBody).toContain("GH_TOKEN='ghp_launcher_secret'");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    // order: run → read (readiness) → send, prompts carry the delivery suffix
    const firstSend = calls.findIndex((c) => c.startsWith("send "));
    expect(calls.findIndex((c) => c.startsWith("read "))).toBeLessThan(firstSend);
    expect(calls[firstSend]).toMatch(new RegExp(`^send t1 Review the fix .*${deliveryDir}/lane-a\\.result\\.md`));

    const manifest = JSON.parse(readFileSync(path.join(deliveryDir, "manifest.json"), "utf8"));
    expect(manifest).toEqual([
      { id: "lane-a", name: "Lane A", paneId: "t1", mux: "herdr" },
      { id: "lane-b", name: "Lane B", paneId: "t2", mux: "herdr" },
    ]);
    expect(result.stdout).toMatch(/hc attach <name>/);
  });

  it("monitor mode and the summary stay on herdr too", () => {
    const { result, tmuxLog, hcLog } = herdrRun({ monitor: true });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(tmuxLog)).toBe(false);
    expect(result.stdout).toMatch(/All 2 agents completed/);
    expect(readFileSync(hcLog, "utf8")).toMatch(/^get t1 --json$/m);
    expect(result.stdout).toMatch(/Watch: .* attach <name>/);
  }, 30_000);

  it("auto stays on tmux inside tmux, and omp.json can force herdr there", () => {
    const inTmux = herdrRun({ env: { TMUX: "/tmp/fake,1,0" } });
    expect(inTmux.result.status, inTmux.result.stderr).toBe(0);
    expect(existsSync(inTmux.hcLog) && readFileSync(inTmux.hcLog, "utf8").includes("run ")).toBe(false);
    expect(readFileSync(inTmux.tmuxLog, "utf8")).toContain("split-window");

    const forced = herdrRun({ env: { TMUX: "/tmp/fake,1,0" }, ompJson: '{"mux":"herdr"}' });
    expect(forced.result.status, forced.result.stderr).toBe(0);
    expect(existsSync(forced.tmuxLog)).toBe(false);
  });

  it("OMP_MUX=tmux overrides omp.json", () => {
    const r = herdrRun({ env: { TMUX: "/tmp/fake,1,0", OMP_MUX: "tmux" }, ompJson: '{"mux":"herdr"}' });
    expect(r.result.status, r.result.stderr).toBe(0);
    expect(readFileSync(r.tmuxLog, "utf8")).toContain("split-window");
  });

  it("falls back to tmux with a notice when hc is missing", () => {
    const r = runLauncher({ control: "success", env: { OMP_MUX: "herdr" } });
    expect(r.result.status, r.result.stderr).toBe(0);
    expect(r.result.stderr).toMatch(/hc not found; using tmux/);
    expect(readFileSync(r.tmuxLog, "utf8")).toContain("split-window");
  });

  it("refuses herdr without a control CLI instead of putting env in argv", () => {
    const r = runLauncher({ control: "none", copiedPackage: "version-mismatch", hc: true, env: { TMUX: "" } });
    expect(r.result.status).toBe(1);
    expect(r.result.stderr).toMatch(/OMP_MUX=tmux/);
    expect(existsSync(r.hcLog) && readFileSync(r.hcLog, "utf8").includes("run ")).toBe(false);
  });
});
