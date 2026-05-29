import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

describe("runCli: bare `omp` launches copilot (bypass off by default)", () => {
  // Capture the exact argv copilot receives via a stub bin. Force the direct
  // (non-tmux-wrap) launch path with TMUX set so the test is deterministic
  // regardless of whether the runner is inside tmux.
  let dir: string;
  let argLog: string;
  let stub: string;
  const saved = {
    bin: process.env.OMP_COPILOT_BIN,
    tmux: process.env.TMUX,
    log: process.env.OMP_STUB_LOG,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-cli-"));
    argLog = join(dir, "argv.json");
    stub = join(dir, "stub-copilot");
    writeFileSync(
      stub,
      '#!/usr/bin/env node\n' +
        'require("node:fs").writeFileSync(process.env.OMP_STUB_LOG, JSON.stringify(process.argv.slice(2)));\n',
    );
    chmodSync(stub, 0o755);
    process.env.OMP_COPILOT_BIN = stub;
    process.env.TMUX = "/tmp/fake,1,0"; // force direct path (no tmux wrap)
    process.env.OMP_STUB_LOG = argLog;
  });

  afterEach(() => {
    for (const [k, v] of [
      ["OMP_COPILOT_BIN", saved.bin],
      ["TMUX", saved.tmux],
      ["OMP_STUB_LOG", saved.log],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("bare `omp` (no args) launches copilot with NO bypass flag", async () => {
    const result = await runCli([]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(argLog, "utf8"))).toEqual([]); // no --yolo
  });

  it("`omp --madmax` launches copilot WITH the bypass flag", async () => {
    const result = await runCli(["--madmax"]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(argLog, "utf8"))).toEqual(["--yolo"]);
  });

  it("`omp help` still prints usage instead of launching", async () => {
    const result = await runCli(["help"]);
    expect(result.message ?? "").toMatch(/oh-my-copilot/);
    expect(() => readFileSync(argLog, "utf8")).toThrow(); // copilot never spawned
  });
});

describe("runCli: bare-flag launch routing", () => {
  it("forwards --madmax to launchCopilot (spawns the configured bin)", async () => {
    const original = process.env.OMP_COPILOT_BIN;
    process.env.OMP_COPILOT_BIN = "/bin/echo";
    try {
      const result = await runCli(["--madmax", "-p", "smoke"]);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.message ?? "").toMatch(/launch \/bin\/echo exit=0/);
    } finally {
      if (original === undefined) delete process.env.OMP_COPILOT_BIN;
      else process.env.OMP_COPILOT_BIN = original;
    }
  });

  it("forwards --yolo to launchCopilot", async () => {
    const original = process.env.OMP_COPILOT_BIN;
    process.env.OMP_COPILOT_BIN = "/bin/echo";
    try {
      const result = await runCli(["--yolo", "-p", "smoke"]);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      if (original === undefined) delete process.env.OMP_COPILOT_BIN;
      else process.env.OMP_COPILOT_BIN = original;
    }
  });

  it("does not forward unknown leading flags — falls through to Unknown-command", async () => {
    const result = await runCli(["--definitely-not-a-real-flag"]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/Unknown command/);
  });

  it("does not forward bare -- sentinel as a launch", async () => {
    const result = await runCli(["--"]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/Unknown command/);
  });

  it("--help still prints help, not launch", async () => {
    const result = await runCli(["--help"]);
    expect(result.ok).toBe(true);
    expect(result.message ?? "").toMatch(/oh-my-copilot/);
  });
});
