import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  launchCopilot,
  normalizeCopilotLaunchArgs,
  resolveCopilotBin,
} from "../../src/copilot/launch.js";

// launchCopilot pre-trusts its cwd by writing the real ~/.copilot/config.json.
// Disable that side effect for the whole suite so tests never mutate user state.
let savedNoAutoTrust: string | undefined;
beforeEach(() => {
  savedNoAutoTrust = process.env.OMP_NO_AUTO_TRUST;
  process.env.OMP_NO_AUTO_TRUST = "1";
});
afterEach(() => {
  if (savedNoAutoTrust === undefined) delete process.env.OMP_NO_AUTO_TRUST;
  else process.env.OMP_NO_AUTO_TRUST = savedNoAutoTrust;
});

describe("resolveCopilotBin", () => {
  it("uses explicit override when provided", () => {
    expect(resolveCopilotBin("/usr/local/bin/copilot")).toBe("/usr/local/bin/copilot");
  });

  it("falls back to OMC_COPILOT_BIN env", () => {
    const original = process.env.OMC_COPILOT_BIN;
    process.env.OMC_COPILOT_BIN = "/env/copilot";
    try {
      expect(resolveCopilotBin()).toBe("/env/copilot");
    } finally {
      if (original === undefined) delete process.env.OMC_COPILOT_BIN;
      else process.env.OMC_COPILOT_BIN = original;
    }
  });

  it("defaults to 'copilot'", () => {
    const original = process.env.OMC_COPILOT_BIN;
    delete process.env.OMC_COPILOT_BIN;
    try {
      expect(resolveCopilotBin()).toBe("copilot");
    } finally {
      if (original !== undefined) process.env.OMC_COPILOT_BIN = original;
    }
  });
});

describe("normalizeCopilotLaunchArgs", () => {
  it("passes args through unchanged when no bypass alias is present", () => {
    expect(normalizeCopilotLaunchArgs(["-p", "hello", "--agent", "planner"])).toEqual([
      "-p",
      "hello",
      "--agent",
      "planner",
    ]);
  });

  it("maps --madmax to --yolo and drops the original token", () => {
    expect(normalizeCopilotLaunchArgs(["--madmax", "-p", "hi"])).toEqual(["-p", "hi", "--yolo"]);
  });

  it("treats --yolo as an alias and strips duplicates", () => {
    expect(normalizeCopilotLaunchArgs(["--yolo", "--madmax"])).toEqual(["--yolo"]);
  });

  it("preserves an explicit --yolo and does not duplicate it when --madmax is also given", () => {
    expect(normalizeCopilotLaunchArgs(["--yolo", "-p", "go", "--madmax"])).toEqual([
      "--yolo",
      "-p",
      "go",
    ]);
  });

  it("leaves --allow-all alone (different copilot flag) but still maps --madmax", () => {
    expect(normalizeCopilotLaunchArgs(["--allow-all", "--madmax"])).toEqual([
      "--allow-all",
      "--yolo",
    ]);
  });

  it("does not treat --madmax=foo as the bypass flag (exact-token only)", () => {
    expect(normalizeCopilotLaunchArgs(["--madmax=foo", "-p", "hi"])).toEqual([
      "--madmax=foo",
      "-p",
      "hi",
    ]);
  });

  it("inserts --yolo before -- sentinel when bypass is requested in the pre-sentinel args", () => {
    expect(normalizeCopilotLaunchArgs(["--madmax", "--", "-p", "hi"])).toEqual([
      "--yolo",
      "--",
      "-p",
      "hi",
    ]);
  });

  it("passes tokens after -- through unchanged (no stripping, no normalization)", () => {
    expect(normalizeCopilotLaunchArgs(["--", "--madmax", "--yolo"])).toEqual([
      "--",
      "--madmax",
      "--yolo",
    ]);
  });

  it("dedups across --, keeping a single --yolo before the sentinel", () => {
    expect(normalizeCopilotLaunchArgs(["--yolo", "--madmax", "--", "echo", "ok"])).toEqual([
      "--yolo",
      "--",
      "echo",
      "ok",
    ]);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("launchCopilot tmux wrapping", () => {
  // Black-box test (matching the real-spawn style of the suite below): use a
  // fake `tmux` on PATH that records its invocation, and a fake copilot bin.
  let dir: string;
  let tmuxLog: string;
  let copilotLog: string;
  let fakeCopilot: string;
  const savedPath = process.env.PATH;
  const savedTmux = process.env.TMUX;
  const savedTmuxLogEnv = process.env.OMP_TEST_TMUX_LOG;
  const savedCopilotLogEnv = process.env.OMP_TEST_COPILOT_LOG;
  // Strip any COPILOT_* vars so the base-shape assertions are not perturbed by
  // -e passthrough args coming from the ambient (possibly BYOK) shell.
  const savedCopilotVars: Record<string, string | undefined> = {};
  const savedForceTmuxWrap = process.env.OMP_FORCE_TMUX_WRAP;

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("COPILOT_")) {
        savedCopilotVars[key] = process.env[key];
        delete process.env[key];
      }
    }
    dir = mkdtempSync(join(tmpdir(), "omp-launch-"));
    tmuxLog = join(dir, "tmux-argv.json");
    copilotLog = join(dir, "copilot-argv.json");
    fakeCopilot = join(dir, "fake-copilot");
    // Node fakes record their argv verbatim as JSON (preserving arg boundaries)
    // and read the log destination from the environment, so no filesystem path
    // is embedded in the script body (robust to spaces/metachars in TMPDIR).
    const fakeTmux = join(dir, "tmux");
    writeFileSync(
      fakeTmux,
      '#!/usr/bin/env node\n' +
        'const a = process.argv.slice(2);\n' +
        'if (a[0] === "-V") { console.log("tmux 3.x-fake"); process.exit(0); }\n' +
        'require("node:fs").writeFileSync(process.env.OMP_TEST_TMUX_LOG, JSON.stringify(a));\n',
    );
    chmodSync(fakeTmux, 0o755);
    writeFileSync(
      fakeCopilot,
      '#!/usr/bin/env node\n' +
        'require("node:fs").writeFileSync(process.env.OMP_TEST_COPILOT_LOG, JSON.stringify(process.argv.slice(2)));\n',
    );
    chmodSync(fakeCopilot, 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
    process.env.OMP_TEST_TMUX_LOG = tmuxLog;
    process.env.OMP_TEST_COPILOT_LOG = copilotLog;
    process.env.OMP_FORCE_TMUX_WRAP = "1";
  });

  afterEach(() => {
    restoreEnv("PATH", savedPath);
    restoreEnv("TMUX", savedTmux);
    restoreEnv("OMP_TEST_TMUX_LOG", savedTmuxLogEnv);
    restoreEnv("OMP_TEST_COPILOT_LOG", savedCopilotLogEnv);
    for (const [key, value] of Object.entries(savedCopilotVars)) {
      restoreEnv(key, value);
      delete savedCopilotVars[key];
    }
    restoreEnv("OMP_FORCE_TMUX_WRAP", savedForceTmuxWrap);
    rmSync(dir, { recursive: true, force: true });
  });

  it("wraps --madmax in a fresh tmux session and maps it to --yolo when not inside tmux", async () => {
    delete process.env.TMUX;
    const result = await launchCopilot({ args: ["--madmax", "probe"], bin: fakeCopilot, cwd: dir });
    expect(result.ok).toBe(true);
    const argv = JSON.parse(readFileSync(tmuxLog, "utf8")) as string[];
    expect(argv).toHaveLength(6);
    expect(argv[0]).toBe("new-session");
    expect(argv[1]).toBe("-s");
    expect(argv[2]).toMatch(/^omp-\d+$/); // generated session name
    expect(argv[3]).toBe("-c");
    expect(argv[4]).toBe(dir); // session opened in exactly the requested cwd
    expect(argv[5]).toBe(`${fakeCopilot} probe --yolo`); // bin + bypass-mapped command
  });

  it("forwards COPILOT_* (BYOK) env into the new tmux session via -e", async () => {
    delete process.env.TMUX;
    const result = await launchCopilot({
      args: ["probe"],
      bin: fakeCopilot,
      cwd: dir,
      env: { ...process.env, COPILOT_PROVIDER_BASE_URL: "https://openrouter.ai/api/v1" },
    });
    expect(result.ok).toBe(true);
    const argv = JSON.parse(readFileSync(tmuxLog, "utf8")) as string[];
    // -e KEY=VALUE appears before the command, which remains the final arg.
    expect(argv).toContain("-e");
    expect(argv).toContain("COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1");
    expect(argv[argv.length - 1]).toBe(`${fakeCopilot} probe`);
    expect(argv[0]).toBe("new-session");
  });

  it("launches directly (no tmux wrap) when already inside tmux", async () => {
    process.env.TMUX = "/tmp/fake,1234,0";
    const result = await launchCopilot({ args: ["--madmax", "probe"], bin: fakeCopilot, cwd: dir });
    expect(result.ok).toBe(true);
    expect(() => readFileSync(tmuxLog, "utf8")).toThrow(); // tmux never invoked
    expect(JSON.parse(readFileSync(copilotLog, "utf8"))).toEqual(["probe", "--yolo"]);
  });
});

describe("launchCopilot", () => {
  // Force the direct (non-tmux-wrap) launch path with TMUX set so exit-code
  // propagation is tested deterministically regardless of whether the runner
  // is inside tmux (the tmux-wrap path is covered by its own describe above).
  const savedTmux = process.env.TMUX;
  beforeEach(() => {
    process.env.TMUX = "/tmp/fake,1,0";
  });
  afterEach(() => {
    restoreEnv("TMUX", savedTmux);
  });

  it("returns exit code 127 when the binary is missing", async () => {
    const result = await launchCopilot({ args: [], bin: "definitely-missing-xyz-binary" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.bin).toBe("definitely-missing-xyz-binary");
  });

  it("propagates exit code from the spawned binary", async () => {
    const result = await launchCopilot({ args: ["-c", "exit 3"], bin: "/bin/sh" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });
});
