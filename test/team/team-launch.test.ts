import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  control?: "success" | "failure" | "invalid" | "none";
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

  const control = path.join(binDir, "fresh-omp");
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
    [script, "--session", session, "--lanes", lanesFile, "--no-monitor"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMUX: "/tmp/fake,1,0",
        TMUX_LOG: tmuxLog,
        CONTROL_LOG: controlLog,
        OMP_MOCK_VERSION:
          options.copiedPackage === "version-mismatch" ? "9.9.9" : "0.31.0",
        ...(explicitControl
          ? { OMP_TEAM_CONTROL_CLI: explicitControl }
          : { OMP_TEAM_CONTROL_CLI: "" }),
        TEAM_POLL_INTERVAL: "0",
      },
    },
  );

  return {
    result,
    controlLog,
    deliveryDir,
    expectedControl,
    tmuxLog,
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
