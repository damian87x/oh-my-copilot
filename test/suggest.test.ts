import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { formatWorkflowSuggestion, suggestWorkflow } from "../src/commands/suggest.js";

describe("suggestWorkflow", () => {
  it.each([
    {
      name: "flaky/failing tasks to debug workflow",
      task: "Fix a Flaky Integration Test",
      workflow: ["/debug", "/ralplan", "/ralph", "/verify"],
      signal: "flaky",
    },
    {
      name: "PR review tasks to review workflow",
      task: "review this PR diff",
      workflow: ["/code-review", "/verify"],
      signal: "review",
    },
    {
      name: "parallel tasks to team workflow",
      task: "split this into parallel independent workstreams",
      workflow: ["/ralplan", "/team", "/code-review", "/verify"],
      signal: "parallel",
    },
    {
      name: "batch changes to ultrawork workflow",
      task: "batch fix across many files",
      workflow: ["/ralplan", "/ultrawork", "/code-review", "/verify"],
      signal: "many files",
    },
    {
      name: "Jira handoff tasks to ticket workflow",
      task: "create a Jira handoff ticket",
      workflow: ["/ralplan", "/jira-ticket"],
      signal: "Jira",
    },
    {
      name: "release quality tasks to QA workflow",
      task: "check release quality confidence",
      workflow: ["/ultraqa", "/verify"],
      signal: "quality",
    },
    {
      name: "TDD tasks to red-green-refactor workflow",
      task: "use TDD for this behavior change",
      workflow: ["/tdd", "/verify"],
      signal: "TDD",
    },
  ])("routes $name", ({ task, workflow, signal }) => {
    const suggestion = suggestWorkflow(task);
    expect(suggestion.ok).toBe(true);
    if (suggestion.ok) {
      expect(suggestion.workflow).toEqual(workflow);
      expect(suggestion.signals).toContain(signal);
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

  it.each([
    ["flag after task", ["suggest", "review this PR", "--json"]],
    ["flag before task", ["suggest", "--json", "review this PR"]],
  ])("returns machine-readable JSON output when %s", async (_name, argv) => {
    const result = await runCli(argv);
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

  it.each([
    ["plain output", ["suggest"], undefined],
    ["JSON output", ["suggest", "--json"], { ok: false, error: 'usage: omp suggest "<task>"' }],
  ])("fails cleanly when task text is missing with %s", async (_name, argv, output) => {
    const result = await runCli(argv);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toBe('usage: omp suggest "<task>"');
    expect(result.output).toEqual(output);
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
