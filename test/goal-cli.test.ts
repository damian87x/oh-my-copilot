import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "omp-session-goal-"));
}

describe("session Goal CLI", () => {
  it("creates one durable Goal for an explicit Copilot session and reports its status", async () => {
    const root = project();

    const created = await runCli([
      "goal",
      "set",
      "Ship the continuation runtime",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "create-1",
      "--json",
    ]);
    const status = await runCli(["goal", "status", "--root", root, "--session-id", "session-1", "--json"]);

    expect(created).toMatchObject({
      ok: true,
      output: {
        schemaVersion: 1,
        ok: true,
        result: {
          sessionId: "session-1",
          objective: "Ship the continuation runtime",
          status: "active",
          turnCount: 0,
          grantedThrough: 20,
        },
      },
    });
    expect(status).toMatchObject({
      ok: true,
      output: {
        schemaVersion: 1,
        ok: true,
        result: {
          sessionId: "session-1",
          objective: "Ship the continuation runtime",
          status: "active",
        },
      },
    });
  });

  it("replays the same operation and rejects a second unfinished Goal", async () => {
    const root = project();
    const argv = [
      "goal",
      "set",
      "First objective",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "create-1",
      "--json",
    ];

    const first = await runCli(argv);
    const replay = await runCli(argv);
    const conflict = await runCli([
      "goal",
      "set",
      "Second objective",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "create-2",
      "--json",
    ]);

    expect(replay.output).toEqual(first.output);
    expect(conflict).toMatchObject({
      ok: false,
      output: {
        schemaVersion: 1,
        ok: false,
        error: { code: "GOAL_EXISTS", retryable: false },
      },
    });
  });

  it("exposes explicit agent completion", async () => {
    const root = project();
    await runCli([
      "goal",
      "set",
      "Finish",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "create-1",
      "--json",
    ]);

    const completed = await runCli([
      "goal",
      "complete",
      "--reason",
      "verification passed",
      "--root",
      root,
      "--session-id",
      "session-1",
      "--operation-id",
      "complete-1",
      "--json",
    ]);

    expect(completed).toMatchObject({
      ok: true,
      output: {
        ok: true,
        result: {
          status: "complete",
          terminalReason: "agent-complete:verification passed",
        },
      },
    });
  });

  it("does not treat the first flag as a missing objective or reason", async () => {
    const root = project();
    const missingObjective = await runCli([
      "goal",
      "set",
      "--session-id",
      "session-1",
      "--operation-id",
      "create-missing",
      "--root",
      root,
      "--json",
    ]);

    expect(missingObjective).toMatchObject({
      ok: false,
      output: {
        ok: false,
        error: { code: "OBJECTIVE_REQUIRED" },
      },
    });

    await runCli([
      "goal",
      "set",
      "Real objective",
      "--session-id",
      "session-1",
      "--operation-id",
      "create-real",
      "--root",
      root,
      "--json",
    ]);
    const missingReason = await runCli([
      "goal",
      "pause",
      "--session-id",
      "session-1",
      "--operation-id",
      "pause-missing",
      "--root",
      root,
      "--json",
    ]);

    expect(missingReason).toMatchObject({
      ok: false,
      output: {
        ok: false,
        error: { code: "REASON_REQUIRED" },
      },
    });
  });
});
