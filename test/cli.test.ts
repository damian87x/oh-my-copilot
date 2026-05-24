import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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
