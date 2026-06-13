import { describe, expect, it } from "vitest";
import {
  buildAdditionalContextOutput,
  buildContinueOutput,
  buildModifiedResultOutput,
  buildPermissionDecisionOutput,
} from "../../scripts/lib/hook-output.mjs";

describe("hook output builders", () => {
  it("emits empty JSON for no-op Copilot command hooks", () => {
    expect(buildContinueOutput()).toEqual({});
  });

  it("emits documented additionalContext without Claude hookSpecificOutput wrapping", () => {
    expect(buildAdditionalContextOutput("ctx")).toEqual({ additionalContext: "ctx" });
  });

  it("emits documented postToolUse modifiedResult output", () => {
    expect(buildModifiedResultOutput("trimmed", "saved tokens")).toEqual({
      modifiedResult: {
        resultType: "success",
        textResultForLlm: "trimmed",
      },
      additionalContext: "saved tokens",
    });
  });

  it("emits documented preToolUse permission decisions and modified args", () => {
    expect(buildPermissionDecisionOutput("deny", "over budget", { command: "true" })).toEqual({
      permissionDecision: "deny",
      permissionDecisionReason: "over budget",
      modifiedArgs: { command: "true" },
    });
  });
});
