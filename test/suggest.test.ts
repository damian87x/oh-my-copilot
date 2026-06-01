import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { formatWorkflowSuggestion, suggestWorkflow } from "../src/commands/suggest.js";

describe("suggestWorkflow", () => {
  it("routes flaky/failing tasks to debug workflow", () => {
    const suggestion = suggestWorkflow("fix a flaky integration test");
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.workflow).toEqual(["/debug", "/ralplan", "/ralph", "/verify"]);
      expect(suggestion.signals).toContain("flaky");
    }
  });

  it("routes PR review tasks to review workflow", () => {
    const suggestion = suggestWorkflow("review this PR diff");
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.workflow).toEqual(["/code-review", "/verify"]);
      expect(suggestion.signals).toContain("review");
    }
  });

  it("routes feature ideas to discovery, clarification, planning, execution, and verification", () => {
    const suggestion = suggestWorkflow("I want to add this feature");
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.workflow).toEqual(["/research-codebase", "/grill-me", "/ralplan", "/ralph", "/verify"]);
      expect(suggestion.signals).toContain("feature");
      expect(suggestion.alternatives).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: expect.stringContaining("still just an idea"),
            workflow: ["/grill-me", "/ralplan"],
          }),
          expect.objectContaining({
            label: expect.stringContaining("scope is already clear"),
            workflow: ["/ralplan", "/ralph", "/verify"],
          }),
        ]),
      );
    }
  });

  it("falls back to the general plan-execute-verify workflow", () => {
    const suggestion = suggestWorkflow("make the thing better");
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.workflow).toEqual(["/ralplan", "/ralph", "/verify"]);
      expect(suggestion.signals).toEqual(["general"]);
      expect(suggestion.alternatives).toBeUndefined();
    }
  });

  it("rejects empty task text", () => {
    expect(suggestWorkflow("   ")).toEqual({ ok: false, error: 'usage: omp suggest "<task>"' });
  });
});

describe("runCli suggest", () => {
  it("renders a concise terminal recommendation", async () => {
    const result = await runCli(["suggest", "fix flaky tests"]);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Recommended workflow:");
    expect(result.message).toContain("/debug → /ralplan → /ralph → /verify");
  });

  it("returns machine-readable JSON output", async () => {
    const result = await runCli(["suggest", "review this PR", "--json"]);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      ok: true,
      workflow: ["/code-review", "/verify"],
      reason: expect.any(String),
      signals: expect.arrayContaining(["review"]),
    });
  });

  it("returns alternatives in JSON for ambiguous feature ideas", async () => {
    const result = await runCli(["suggest", "I want to add this feature", "--json"]);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      ok: true,
      workflow: ["/research-codebase", "/grill-me", "/ralplan", "/ralph", "/verify"],
      reason: expect.any(String),
      signals: expect.arrayContaining(["feature"]),
      alternatives: expect.arrayContaining([
        expect.objectContaining({ workflow: ["/grill-me", "/ralplan"] }),
        expect.objectContaining({ workflow: ["/ralplan", "/ralph", "/verify"] }),
      ]),
    });
  });

  it("fails cleanly when task text is missing", async () => {
    const result = await runCli(["suggest"]);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe('usage: omp suggest "<task>"');
  });

  it("appears in help output", async () => {
    const result = await runCli(["help"]);
    expect(result.message).toContain("suggest");
    expect(result.message).toContain("recommend a slash-skill workflow");
  });
});

describe("formatWorkflowSuggestion", () => {
  it("formats workflow and matched signals", () => {
    const text = formatWorkflowSuggestion({
      ok: true,
      workflow: ["/tdd", "/verify"],
      reason: "use red-green-refactor, then verify.",
      signals: ["TDD"],
    });
    expect(text).toContain("/tdd → /verify");
    expect(text).toContain("matched signals: TDD");
  });

  it("formats alternative workflows when present", () => {
    const text = formatWorkflowSuggestion({
      ok: true,
      workflow: ["/research-codebase", "/grill-me", "/ralplan", "/ralph", "/verify"],
      reason: "feature idea needs discovery and clarification.",
      signals: ["feature"],
      alternatives: [
        {
          label: "If it is still just an idea",
          workflow: ["/grill-me", "/ralplan"],
          reason: "clarify first, then plan.",
        },
        {
          label: "If scope is already clear",
          workflow: ["/ralplan", "/ralph", "/verify"],
          reason: "skip discovery and execute the clear plan.",
        },
      ],
    });
    expect(text).toContain("Also consider:");
    expect(text).toContain("If it is still just an idea: /grill-me → /ralplan");
    expect(text).toContain("If scope is already clear: /ralplan → /ralph → /verify");
  });
});
