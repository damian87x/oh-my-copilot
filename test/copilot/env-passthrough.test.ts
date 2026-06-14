import { describe, expect, it } from "vitest";
import { copilotEnvPassthroughArgs } from "../../src/copilot/env-passthrough.js";

describe("copilotEnvPassthroughArgs", () => {
  it("emits -e KEY=VALUE for COPILOT_* vars, sorted, ignoring others", () => {
    const args = copilotEnvPassthroughArgs({
      COPILOT_MODEL: "openai/gpt-oss-120b:free",
      COPILOT_PROVIDER_BASE_URL: "https://openrouter.ai/api/v1",
      PATH: "/usr/bin",
      HOME: "/home/x",
    });
    expect(args).toEqual([
      "-e",
      "COPILOT_MODEL=openai/gpt-oss-120b:free",
      "-e",
      "COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1",
    ]);
  });

  it("returns no args when no COPILOT_* vars are present", () => {
    expect(copilotEnvPassthroughArgs({ PATH: "/usr/bin", TERM: "xterm" })).toEqual([]);
  });

  it("skips undefined values", () => {
    expect(copilotEnvPassthroughArgs({ COPILOT_MODEL: undefined })).toEqual([]);
  });
});
