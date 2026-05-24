import { describe, expect, it } from "vitest";
import {
  launchCopilot,
  normalizeCopilotLaunchArgs,
  resolveCopilotBin,
} from "../../src/copilot/launch.js";

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
