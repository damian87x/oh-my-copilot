import { describe, expect, it } from "vitest";
import { normalizeHookInput } from "../../scripts/lib/hook-input.mjs";

describe("normalizeHookInput", () => {
  it("normalizes documented camelCase postToolUse payloads", () => {
    const input = normalizeHookInput({
      sessionId: "s-1",
      timestamp: 123,
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "npm test" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "ok",
      },
    });

    expect(input).toMatchObject({
      sessionId: "s-1",
      cwd: "/repo",
      toolName: "bash",
      toolArgs: { command: "npm test" },
      toolResult: { resultType: "success", textResultForLlm: "ok" },
    });
  });

  it("normalizes VS Code-compatible snake_case postToolUse payloads", () => {
    const input = normalizeHookInput({
      hook_event_name: "PostToolUse",
      session_id: "s-2",
      cwd: "/repo2",
      tool_name: "grep",
      tool_input: { pattern: "TODO" },
      tool_result: {
        result_type: "success",
        text_result_for_llm: "matches",
      },
    });

    expect(input).toMatchObject({
      hookEventName: "PostToolUse",
      sessionId: "s-2",
      cwd: "/repo2",
      toolName: "grep",
      toolArgs: { pattern: "TODO" },
      toolResult: { resultType: "success", textResultForLlm: "matches" },
    });
  });

  it("keeps legacy directory payloads working while preferring documented cwd", () => {
    expect(normalizeHookInput({ session_id: "legacy", directory: "/old" })).toMatchObject({
      sessionId: "legacy",
      cwd: "/old",
    });
    expect(normalizeHookInput({ sessionId: "new", cwd: "/new", directory: "/old" })).toMatchObject({
      sessionId: "new",
      cwd: "/new",
    });
  });
});
