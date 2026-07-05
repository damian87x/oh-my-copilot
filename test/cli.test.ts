import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

// Mock the OS installer so `schedule` CLI tests never touch real launchctl/crontab.
vi.mock("../src/schedule/installer.js", () => ({
  installJob: vi.fn(() => ({ backend: "crontab", installed: true })),
  uninstallJob: vi.fn(),
  getInstalledStatus: vi.fn(() => false),
}));

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
  // Force the direct (non-tmux-wrap) launch path with TMUX set so spawn
  // results are deterministic regardless of whether the runner is inside tmux.
  const savedTmux = process.env.TMUX;
  beforeEach(() => {
    process.env.TMUX = "/tmp/fake,1,0";
  });
  afterEach(() => {
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
  });

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

  it("forwards bare -p headless prompts to launchCopilot", async () => {
    const original = process.env.OMP_COPILOT_BIN;
    process.env.OMP_COPILOT_BIN = "/bin/echo";
    try {
      const result = await runCli(["-p", "smoke"]);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.message ?? "").toMatch(/launch \/bin\/echo exit=0/);
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

describe("runCli: version", () => {
  let dir: string;
  let savedNoUpdate: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-cli-version-"));
    // The update notice is exercised here, so don't inherit an ambient
    // OMP_NO_UPDATE_CHECK (CI sets it globally for hermetic runs).
    savedNoUpdate = process.env.OMP_NO_UPDATE_CHECK;
    delete process.env.OMP_NO_UPDATE_CHECK;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    if (savedNoUpdate === undefined) delete process.env.OMP_NO_UPDATE_CHECK;
    else process.env.OMP_NO_UPDATE_CHECK = savedNoUpdate;
  });

  it("includes the update notice when npm has a newer version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: "999.0.0" }), { status: 200 })),
    );

    const result = await runCli(["--version", "--root", dir]);

    expect(result.ok).toBe(true);
    expect(result.message ?? "").toContain("[OMP UPDATE AVAILABLE]");
    expect(result.message ?? "").toContain("v999.0.0");
    expect(result.message ?? "").toContain("npm i -g @damian87/omp@latest");
  });
});

describe("runCli: schedule subcommands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-cli-sched-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("help lists the schedule commands", async () => {
    const result = await runCli(["help"]);
    expect(result.message ?? "").toMatch(/schedule add/);
    expect(result.message ?? "").toMatch(/schedule run-now/);
  });

  it("add requires --id, --cron, --prompt", async () => {
    const result = await runCli(["schedule", "add", "--root", dir]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/requires --id, --cron, and --prompt/);
  });

  it("add then list --json round-trips; add prints the safe-default note", async () => {
    const add = await runCli(["schedule", "add", "--id", "pr", "--cron", "*/15 * * * *", "--prompt", "check PR", "--root", dir]);
    expect(add.ok).toBe(true);
    expect(add.message ?? "").toMatch(/without --allow-all-tools/);
    const list = await runCli(["schedule", "list", "--root", dir, "--json"]);
    expect(Array.isArray(list.output)).toBe(true);
    expect((list.output as Array<{ id: string }>)[0].id).toBe("pr");
  });

  it("add --allow-all-tools prints the WARNING", async () => {
    const add = await runCli(["schedule", "add", "--id", "danger", "--cron", "0 * * * *", "--prompt", "act", "--allow-all-tools", "--root", dir]);
    expect(add.message ?? "").toMatch(/WARNING.*full tool access/);
  });

  it("remove deletes the job", async () => {
    await runCli(["schedule", "add", "--id", "pr", "--cron", "*/15 * * * *", "--prompt", "x", "--root", dir]);
    const rm = await runCli(["schedule", "remove", "pr", "--root", dir]);
    expect(rm.ok).toBe(true);
    const list = await runCli(["schedule", "list", "--root", dir, "--json"]);
    expect((list.output as unknown[]).length).toBe(0);
  });

  it("unknown schedule subcommand errors", async () => {
    const result = await runCli(["schedule", "frobnicate", "--root", dir]);
    expect(result.ok).toBe(false);
    expect(result.message ?? "").toMatch(/Unknown schedule subcommand/);
  });

  it("run parses the id from the --id flag (the OS-scheduler argv shape)", async () => {
    // OS entries invoke `omp schedule run --id <id> --root <dir>`. A missing job is
    // a clean no-op; the message must name the real id ("ghost"), not the literal "--id".
    const result = await runCli(["schedule", "run", "--id", "ghost", "--root", dir]);
    expect(result.ok).toBe(true); // missing-job no-op exits 0 (no crash-restart)
    expect(result.message ?? "").toContain("ghost");
    expect(result.message ?? "").not.toContain('"--id"');
  });

  it.each(["status", "open", "remove", "run-now"])("rejects invalid schedule ids for %s before path construction", async (cmd) => {
    const result = await runCli(["schedule", cmd, "../escape", "--root", dir]);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message ?? "").toMatch(/invalid schedule id/);
  });
});
