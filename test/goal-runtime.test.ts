import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error - plain .mjs runtime exports are exercised through their public API.
import { goalCommand, goalRuntimeInternals } from "../scripts/lib/goal-runtime.mjs";

const fixtures: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-goal-runtime-"));
  fixtures.push(root);
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

async function command(
  root: string,
  commandName: string,
  operationId: string,
  input: Record<string, unknown> = {},
) {
  const generationBound = new Set(["complete", "extend", "turn"]);
  const status = generationBound.has(commandName) && input.expectedGoalGeneration === undefined
    ? goalCommand({ root, command: "status", sessionId: "session-1" })
    : undefined;
  return goalCommand({
    root,
    command: commandName,
    sessionId: "session-1",
    operationId,
    ...(status?.ok && typeof status.result.goalGeneration === "string"
      ? { expectedGoalGeneration: status.result.goalGeneration }
      : {}),
    ...input,
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Goal lifecycle", () => {
  it("edits, pauses, resumes, replaces, and clears one unfinished Goal", async () => {
    const root = project();

    await command(root, "set", "create-1", { objective: "First objective" });
    expect(await command(root, "edit", "edit-1", { objective: "Sharper objective" })).toMatchObject({
      ok: true,
      result: { objective: "Sharper objective", status: "active", revision: 2 },
    });
    expect(await command(root, "pause", "pause-1", { reason: "waiting for input" })).toMatchObject({
      ok: true,
      result: { status: "paused", pauseReason: "waiting for input", revision: 3 },
    });
    expect(await command(root, "resume", "resume-1")).toMatchObject({
      ok: true,
      result: { status: "active", revision: 4 },
    });
    expect(await command(root, "replace", "replace-1", { objective: "Replacement objective" })).toMatchObject({
      ok: true,
      result: {
        objective: "Replacement objective",
        status: "active",
        turnCount: 0,
        grantedThrough: 20,
        revision: 5,
      },
    });
    expect(await command(root, "clear", "clear-1", { reason: "cancelled by user" })).toMatchObject({
      ok: true,
      result: { status: "cleared", revision: 6 },
    });
    expect(await command(root, "set", "create-2", { objective: "Allowed after terminal state" })).toMatchObject({
      ok: true,
      result: { objective: "Allowed after terminal state", status: "active", revision: 7 },
    });
  });

  it("rejects operation-id reuse with different input instead of replaying the wrong result", async () => {
    const root = project();
    await command(root, "set", "same-op", { objective: "Original" });

    expect(await command(root, "set", "same-op", { objective: "Different" })).toMatchObject({
      ok: false,
      error: { code: "OPERATION_COLLISION", retryable: false },
    });
  });

  it("scopes operation replay to the current Goal generation", async () => {
    const root = project();
    await command(root, "set", "create-a", { objective: "Goal A" });
    await command(root, "complete", "goal-complete-1", {
      reason: "fresh verification passed",
    });
    await command(root, "set", "create-b", { objective: "Goal B" });

    expect(
      await command(root, "complete", "goal-complete-1", {
        reason: "fresh verification passed",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        objective: "Goal B",
        status: "complete",
        terminalReason: "agent-complete:fresh verification passed",
      },
    });
    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Goal B", status: "complete" },
    });
  });

  it("returns one durable Goal generation from create, replay, and status", async () => {
    const root = project();
    const created = await command(root, "set", "create-generation", {
      objective: "Generation-bound Goal",
    });
    const replayed = await command(root, "set", "create-generation", {
      objective: "Generation-bound Goal",
    });
    const status = await command(root, "status", "unused");

    expect(created).toMatchObject({
      ok: true,
      result: { goalGeneration: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(replayed).toEqual(created);
    expect(status).toMatchObject({
      ok: true,
      result: { goalGeneration: created.result.goalGeneration },
    });
  });

  it("atomically rejects a mutation bound to an older Goal generation", async () => {
    const root = project();
    const created = await command(root, "set", "create-a", {
      objective: "Goal A",
    });
    await command(root, "replace", "replace-b", { objective: "Goal B" });

    expect(
      await command(root, "turn", "old-generation-turn", {
        expectedGoalGeneration: created.result.goalGeneration,
        turnId: "old-generation-turn",
        assistantText: "OMP_GOAL_COMPLETE",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "GOAL_GENERATION_MISMATCH", retryable: false },
    });
    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Goal B", status: "active", turnCount: 0 },
    });
  });

  it("rejects agent completion that omits the active Goal generation", async () => {
    const root = project();
    await command(root, "set", "create-a", { objective: "Goal A" });
    await command(root, "replace", "replace-b", { objective: "Goal B" });

    const unbound = goalCommand({
      root,
      command: "complete",
      sessionId: "session-1",
      operationId: "stale-unbound-complete",
      reason: "stale completion",
    });

    expect(unbound).toMatchObject({
      ok: false,
      error: { code: "GOAL_GENERATION_REQUIRED", retryable: false },
    });
    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Goal B", status: "active", turnCount: 0 },
    });
  });

  it("normalizes every Goal stream path to the repository root", async () => {
    const root = project();
    const nested = join(root, "packages", "service", "src");
    mkdirSync(nested, { recursive: true });

    await command(root, "set", "create-rooted", { objective: "One rooted Goal" });

    expect(goalCommand({
      root: nested,
      command: "status",
      sessionId: "session-1",
    })).toMatchObject({
      ok: true,
      result: { objective: "One rooted Goal", status: "active" },
    });
    expect(goalRuntimeInternals.streamPaths(nested, "session-1")).toEqual(
      goalRuntimeInternals.streamPaths(root, "session-1"),
    );
    expect(existsSync(join(nested, ".omp", "state", "goals"))).toBe(false);
  });

  it("lets the agent complete explicitly before AgentStop when Copilot has not flushed the transcript", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Finish" });

    expect(
      await command(root, "complete", "complete-1", {
        reason: "fresh verification passed",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "complete",
        terminalReason: "agent-complete:fresh verification passed",
        turnCount: 0,
      },
    });
  });
});

describe("Goal turn policy", () => {
  it("binds continuation commands to the current Goal generation", async () => {
    const root = project();
    const created = await command(root, "set", "create", { objective: "Finish safely" });
    const generation = created.result.goalGeneration;

    const turn = await command(root, "turn", "turn-1", {
      turnId: "turn-1",
      assistantText: "Still working.",
    });

    expect(turn).toMatchObject({
      ok: true,
      result: {
        reason: expect.stringContaining(
          `--expected-goal-generation "${generation}"`,
        ),
      },
    });
  });

  it("uses exact latest-message markers for completion and three-consecutive blocker decisions", async () => {
    const completeRoot = project();
    await command(completeRoot, "set", "create", { objective: "Finish" });
    expect(
      await command(completeRoot, "turn", "turn-1", {
        turnId: "turn-1",
        assistantText: "All checks pass.\nOMP_GOAL_COMPLETE",
      }),
    ).toMatchObject({
      ok: true,
      result: { status: "complete", turnCount: 1, decision: "allow" },
    });

    const blockedRoot = project();
    await command(blockedRoot, "set", "create", { objective: "Finish" });
    for (let turn = 1; turn <= 2; turn += 1) {
      expect(
        await command(blockedRoot, "turn", `turn-${turn}`, {
          turnId: `turn-${turn}`,
          assistantText: 'OMP_GOAL_BLOCKED {"key":"missing-token"}',
        }),
      ).toMatchObject({
        ok: true,
        result: { status: "active", blocker: { key: "missing-token", count: turn } },
      });
    }
    expect(
      await command(blockedRoot, "turn", "turn-3", {
        turnId: "turn-3",
        assistantText: 'OMP_GOAL_BLOCKED {"key":"missing-token"}',
      }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "blocked",
        turnCount: 3,
        decision: "allow",
        blocker: { key: "missing-token", count: 3 },
      },
    });
  });

  it("resets the blocker streak and treats marker-like prose as ordinary output", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Finish" });
    await command(root, "turn", "turn-1", {
      turnId: "turn-1",
      assistantText: 'OMP_GOAL_BLOCKED {"key":"same"}',
    });
    await command(root, "turn", "turn-2", {
      turnId: "turn-2",
      assistantText: "I may later write OMP_GOAL_BLOCKED mid-sentence.",
    });
    expect(
      await command(root, "turn", "turn-3", {
        turnId: "turn-3",
        assistantText: 'OMP_GOAL_BLOCKED {"key":"same"}',
      }),
    ).toMatchObject({
      ok: true,
      result: { status: "active", blocker: { key: "same", count: 1 } },
    });
  });

  it("pauses at turn 20 without an extension and grants the next window with a reason", async () => {
    const pausedRoot = project();
    await command(pausedRoot, "set", "create", { objective: "Finish" });
    let paused;
    for (let turn = 1; turn <= 20; turn += 1) {
      paused = await command(pausedRoot, "turn", `turn-${turn}`, {
        turnId: `turn-${turn}`,
        assistantText: "Still working.",
      });
    }
    expect(paused).toMatchObject({
      ok: true,
      result: { status: "paused", turnCount: 20, grantedThrough: 20, decision: "allow" },
    });

    const extendedRoot = project();
    await command(extendedRoot, "set", "create", { objective: "Finish" });
    let extended;
    for (let turn = 1; turn <= 20; turn += 1) {
      extended = await command(extendedRoot, "turn", `turn-${turn}`, {
        turnId: `turn-${turn}`,
        assistantText:
          turn === 20
            ? 'OMP_GOAL_EXTEND {"reason":"integration verification remains"}'
            : "Still working.",
      });
    }
    expect(extended).toMatchObject({
      ok: true,
      result: { status: "active", turnCount: 20, grantedThrough: 40, decision: "block" },
    });
  }, 10000);

  it("requires the missed extension before resuming a boundary-paused Goal", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Finish" });
    for (let turn = 1; turn <= 20; turn += 1) {
      await command(root, "turn", `turn-${turn}`, {
        turnId: `turn-${turn}`,
        assistantText: "Still working.",
      });
    }

    expect(await command(root, "resume", "resume-without-extension")).toMatchObject({
      ok: false,
      error: { code: "GOAL_EXTENSION_REQUIRED" },
    });
    expect(
      await command(root, "extend", "extend-after-pause", {
        reason: "integration verification remains",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "active",
        turnCount: 20,
        grantedThrough: 40,
      },
    });
    expect(
      await command(root, "turn", "turn-21", {
        turnId: "turn-21",
        assistantText: "Still working.",
      }),
    ).toMatchObject({
      ok: true,
      result: { status: "active", turnCount: 21, grantedThrough: 40 },
    });
  });

  it("pre-grants the next window when the agent decides during the boundary turn", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Finish" });
    for (let turn = 1; turn <= 19; turn += 1) {
      await command(root, "turn", `turn-${turn}`, {
        turnId: `turn-${turn}`,
        assistantText: "Still working.",
      });
    }

    expect(
      await command(root, "extend", "extend-20", {
        reason: "the live integration gate still needs verification",
      }),
    ).toMatchObject({
      ok: true,
      result: {
        status: "active",
        turnCount: 19,
        grantedThrough: 40,
        extensionHistory: [
          {
            turn: 20,
            reason: "the live integration gate still needs verification",
          },
        ],
      },
    });
    expect(
      await command(root, "turn", "turn-20", {
        turnId: "turn-20",
        assistantText: "Still working without a transcript marker.",
      }),
    ).toMatchObject({
      ok: true,
      result: { status: "active", turnCount: 20, grantedThrough: 40, decision: "block" },
    });
  });

  it(
    "lets the agent extend each 20-turn window but always stops at turn 100",
    async () => {
      const root = project();
      await command(root, "set", "create", { objective: "Finish" });
      let result;
      for (let turn = 1; turn <= 100; turn += 1) {
        const shouldExtend = [20, 40, 60, 80].includes(turn);
        result = await command(root, "turn", `turn-${turn}`, {
          turnId: `turn-${turn}`,
          assistantText: shouldExtend
            ? `OMP_GOAL_EXTEND {"reason":"verified work remains after turn ${turn}"}`
            : "Still working.",
        });
        if (shouldExtend) {
          expect(result).toMatchObject({
            ok: true,
            result: {
              status: "active",
              turnCount: turn,
              grantedThrough: turn + 20,
              decision: "block",
            },
          });
        }
      }

      expect(result).toMatchObject({
        ok: true,
        result: {
          status: "blocked",
          turnCount: 100,
          grantedThrough: 100,
          terminalReason: "hard-turn-limit",
          decision: "allow",
        },
      });
    },
    15_000,
  );
});

describe("Goal ledger recovery and integrity", () => {
  it("recovers an aggregate lock whose owner process is dead", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Recover the lock" });
    const paths = goalRuntimeInternals.streamPaths(root, "session-1");
    writeFileSync(
      paths.lock,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Recover the lock", status: "active" },
    });
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("does not enter while a live stale-lock recovery claim exists", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Protect recovery" });
    const paths = goalRuntimeInternals.streamPaths(root, "session-1");
    writeFileSync(
      paths.lock,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        acquiredAt: new Date().toISOString(),
        token: "stale",
      })}\n`,
      "utf8",
    );
    const claim = `${paths.lock}.recovery-${process.pid}-test`;
    linkSync(paths.lock, claim);

    expect(await command(root, "status", "unused")).toMatchObject({
      ok: false,
      error: { code: "GOAL_BUSY", retryable: true },
    });
    rmSync(claim, { force: true });
    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Protect recovery", status: "active" },
    });
  });

  it("recovers a durable pending transaction before serving status", async () => {
    const root = project();
    await command(root, "set", "create", { objective: "Recover me" });
    const paths = goalRuntimeInternals.streamPaths(root, "session-1");
    const transaction = readFileSync(paths.ledger, "utf8");

    writeFileSync(paths.pending, transaction, "utf8");
    truncateSync(paths.ledger, 0);

    expect(await command(root, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Recover me", status: "active", revision: 1 },
    });
    expect(readFileSync(paths.ledger, "utf8")).toBe(transaction);
  });

  it("drops only an incomplete final ledger tail and rejects complete corruption", async () => {
    const recoverableRoot = project();
    await command(recoverableRoot, "set", "create", { objective: "Keep me" });
    const recoverablePaths = goalRuntimeInternals.streamPaths(recoverableRoot, "session-1");
    appendFileSync(recoverablePaths.ledger, '{"schemaVersion":1', "utf8");

    expect(await command(recoverableRoot, "status", "unused")).toMatchObject({
      ok: true,
      result: { objective: "Keep me", revision: 1 },
    });
    expect(readFileSync(recoverablePaths.ledger, "utf8").endsWith("\n")).toBe(true);

    const corruptRoot = project();
    await command(corruptRoot, "set", "create", { objective: "Do not hide corruption" });
    const corruptPaths = goalRuntimeInternals.streamPaths(corruptRoot, "session-1");
    appendFileSync(corruptPaths.ledger, "{}\n", "utf8");

    expect(await command(corruptRoot, "status", "unused")).toMatchObject({
      ok: false,
      error: { code: "LEDGER_CORRUPT", retryable: false },
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked ledger without repairing the external target",
    async () => {
      const root = project();
      await command(root, "set", "create", { objective: "Keep writes inside the Goal stream" });
      const paths = goalRuntimeInternals.streamPaths(root, "session-1");
      const externalRoot = project();
      const externalLedger = join(externalRoot, "external-ledger.jsonl");
      const ledgerWithoutNewline = readFileSync(paths.ledger, "utf8").trimEnd();
      writeFileSync(externalLedger, ledgerWithoutNewline, "utf8");
      rmSync(paths.ledger);
      symlinkSync(externalLedger, paths.ledger);

      const result = await command(root, "status", "unused");

      expect(readFileSync(externalLedger, "utf8")).toBe(ledgerWithoutNewline);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "LEDGER_CORRUPT", retryable: false },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a ledger swapped to a symlink after validation without appending externally",
    async () => {
      const root = project();
      const created = await command(root, "set", "create", {
        objective: "Keep appends inside the Goal stream",
      });
      const paths = goalRuntimeInternals.streamPaths(root, "session-1");
      const externalRoot = project();
      const externalLedger = join(externalRoot, "external-ledger.jsonl");
      const externalBefore = "DO NOT APPEND\n";
      writeFileSync(externalLedger, externalBefore, "utf8");
      const originalToISOString = Date.prototype.toISOString;
      let timestampCalls = 0;
      const timestampSpy = vi
        .spyOn(Date.prototype, "toISOString")
        .mockImplementation(function toISOString() {
          timestampCalls += 1;
          if (timestampCalls === 2) {
            rmSync(paths.ledger);
            symlinkSync(externalLedger, paths.ledger);
          }
          return originalToISOString.call(this);
        });

      let result;
      try {
        result = goalCommand({
          root,
          command: "pause",
          sessionId: "session-1",
          operationId: "pause-after-ledger-swap",
          expectedGoalGeneration: created.result.goalGeneration,
          reason: "exercise append boundary",
        });
      } finally {
        timestampSpy.mockRestore();
      }

      expect(readFileSync(externalLedger, "utf8")).toBe(externalBefore);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "LEDGER_CORRUPT", retryable: false },
      });
    },
  );
});
