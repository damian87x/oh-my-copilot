import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "omp-ultragoal-cli-"));
}

describe("Ultragoal CLI", () => {
  it("creates and starts a sequential plan under an active session Goal", async () => {
    const root = project();
    await runCli([
      "goal",
      "set",
      "Ship safely",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "goal-create",
      "--json",
    ]);
    const stories = JSON.stringify([
      {
        title: "Implement",
        objective: "Implement the feature.",
        criteria: ["tests pass"],
      },
      {
        title: "Verify",
        objective: "Verify the live flow.",
        criteria: ["live gate passes"],
      },
    ]);

    const created = await runCli([
      "ultragoal",
      "create",
      "Ship safely",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "plan-create",
      "--stories-json",
      stories,
      "--json",
    ]);
    const started = await runCli([
      "ultragoal",
      "next",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "story-start",
      "--json",
    ]);

    expect(created).toMatchObject({
      ok: true,
      output: {
        schemaVersion: 1,
        ok: true,
        result: { revision: 1, stories: [{ id: "G001" }, { id: "G002" }] },
      },
    });
    expect(started).toMatchObject({
      ok: true,
      output: {
        schemaVersion: 1,
        ok: true,
        result: { activeStoryId: "G001", revision: 2 },
      },
    });
  });

  it("refuses to create an Ultragoal without an active session Goal", async () => {
    const root = project();
    const result = await runCli([
      "ultragoal",
      "create",
      "No outer Goal",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "plan-create",
      "--json",
    ]);

    expect(result).toMatchObject({
      ok: false,
      output: {
        schemaVersion: 1,
        ok: false,
        error: { code: "GOAL_REQUIRED", retryable: false },
      },
    });
  });

  it("does not store a flag as the defaulted Ultragoal objective", async () => {
    const root = project();
    await runCli([
      "goal",
      "set",
      "Outer Goal objective",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "goal-create",
      "--json",
    ]);

    const created = await runCli([
      "ultragoal",
      "create",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "plan-create",
      "--json",
    ]);

    expect(created).toMatchObject({
      ok: true,
      output: {
        ok: true,
        result: { objective: "Outer Goal objective" },
      },
    });
  });
});
