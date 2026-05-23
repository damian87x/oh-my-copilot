import { describe, expect, it } from "vitest";
import { launchCopilot, resolveCopilotBin } from "../../src/copilot/launch.js";

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

describe("launchCopilot", () => {
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
