import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRalph } from "../../src/mode-state/ralph.js";
import {
  createUltragoal,
  startNextUltragoalStory,
} from "../../src/ultragoal/runtime.js";
// @ts-expect-error - plain .mjs hook script exports are exercised as public handlers.
import { handlePromptSubmit } from "../../scripts/prompt-submit.mjs";
// @ts-expect-error - plain .mjs hook script exports are exercised as public handlers.
import { handleSessionStart } from "../../scripts/session-start.mjs";
// @ts-expect-error - plain .mjs runtime exports are exercised through their public API.
import { goalCommand } from "../../scripts/lib/goal-runtime.mjs";

const fixtures: string[] = [];
const savedVersionOverride = process.env.OMP_VERSION_OVERRIDE;

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-goal-hooks-"));
  fixtures.push(root);
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function createGoal(root: string, sessionId: string, objective = "Finish the session objective") {
  return goalCommand({
    root,
    command: "set",
    sessionId,
    operationId: `create-${sessionId}`,
    objective,
  });
}

afterEach(() => {
  if (savedVersionOverride === undefined) delete process.env.OMP_VERSION_OVERRIDE;
  else process.env.OMP_VERSION_OVERRIDE = savedVersionOverride;
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Goal lifecycle hook context", () => {
  it("injects distinct project-goal and active session Goal context at SessionStart", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0";
    const root = project();
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "goal.md"), "# Repo Goal\n\nShip the product\n", "utf8");
    const goal = createGoal(root, "session-1");
    if (!goal.ok || typeof goal.result.goalGeneration !== "string") {
      throw new Error("Goal fixture did not expose its generation");
    }

    const output = await handleSessionStart(
      JSON.stringify({ cwd: root, sessionId: "session-1" }),
    );
    const context = output.additionalContext ?? "";

    expect(context).toContain("[OMP SESSION] session-1");
    expect(context).toContain("[PROJECT GOAL] Ship the product");
    expect(context).toContain("[GOAL ACTIVE: turn 0/20]");
    expect(context).toContain("Finish the session objective");
    expect(context).toContain("omp goal complete");
    expect(context).toContain(
      `--expected-goal-generation "${goal.result.goalGeneration}"`,
    );
    expect(context).toContain("OMP_GOAL_COMPLETE");
    expect(context).not.toContain("omp goal extend");
    expect(context).not.toContain("[REPO GOAL]");
  });

  it("uses the repository-root Goal from nested hook working directories", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0";
    const root = project();
    const nested = join(root, "packages", "service", "src");
    mkdirSync(nested, { recursive: true });
    createGoal(root, "session-1", "Keep one repository-root Goal");

    const started = await handleSessionStart(
      JSON.stringify({ cwd: nested, sessionId: "session-1" }),
    );
    const prompted = await handlePromptSubmit(
      JSON.stringify({
        cwd: nested,
        sessionId: "session-1",
        prompt: "continue",
      }),
    );

    expect(started.additionalContext).toContain("[GOAL ACTIVE: turn 0/20]");
    expect(started.additionalContext).toContain("Keep one repository-root Goal");
    expect(prompted.additionalContext).toContain("[GOAL ACTIVE: turn 0/20]");
    expect(prompted.additionalContext).toContain("Keep one repository-root Goal");
    expect(existsSync(join(nested, ".omp", "state", "goals"))).toBe(false);
  });

  it("injects only session-owned nested modes under an active Goal", async () => {
    const root = project();
    createGoal(root, "goal-session");
    startRalph({
      cwd: root,
      prompt: "other session work",
      sessionId: "other-session",
      maxIterations: 3,
    });

    const other = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "continue" }),
    );
    expect(other.additionalContext).toContain("[GOAL ACTIVE: turn 0/20]");
    expect(other.additionalContext).not.toContain("[RALPH ACTIVE");

    startRalph({
      cwd: root,
      prompt: "owned work",
      sessionId: "goal-session",
      maxIterations: 3,
    });
    const owned = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "continue" }),
    );
    expect(owned.additionalContext).toContain("[GOAL ACTIVE: turn 0/20]");
    expect(owned.additionalContext).toContain("[RALPH ACTIVE: iteration 0/3]");
  });

  it("gives the agent the explicit extension command before turn 20", async () => {
    const root = project();
    const goal = createGoal(root, "goal-session");
    if (!goal.ok || typeof goal.result.goalGeneration !== "string") {
      throw new Error("Goal fixture did not expose its generation");
    }
    for (let turn = 1; turn <= 19; turn += 1) {
      goalCommand({
        root,
        command: "turn",
        sessionId: "goal-session",
        operationId: `turn-${turn}`,
        expectedGoalGeneration: goal.result.goalGeneration,
        turnId: `turn-${turn}`,
        assistantText: "Still working.",
      });
    }

    const output = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "continue" }),
    );

    expect(output.additionalContext).toContain("[GOAL ACTIVE: turn 19/20]");
    expect(output.additionalContext).toContain("omp goal extend");
    expect(output.additionalContext).toContain('goal-extend-20');
    expect(output.additionalContext).toContain(
      `--expected-goal-generation "${goal.result.goalGeneration}"`,
    );
  });

  it("does not inject terminal Goal context into every later prompt", async () => {
    const root = project();
    const goal = createGoal(root, "goal-session");
    if (!goal.ok || typeof goal.result.goalGeneration !== "string") {
      throw new Error("Goal fixture did not expose its generation");
    }
    goalCommand({
      root,
      command: "complete",
      sessionId: "goal-session",
      operationId: "complete-goal",
      expectedGoalGeneration: goal.result.goalGeneration,
      reason: "fresh verification passed",
    });

    const output = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "new work" }),
    );

    expect(output.additionalContext ?? "").not.toContain("[GOAL COMPLETE");
    expect(output.additionalContext ?? "").not.toContain("Finish the session objective");
  });

  it("injects the current sequential Ultragoal story and its unmet criteria", async () => {
    const root = project();
    const goal = createGoal(root, "goal-session");
    createUltragoal({
      cwd: root,
      sessionId: "goal-session",
      operationId: "plan-create",
      objective: "Finish the session objective",
      goalGeneration: goal.result.goalGeneration,
      stories: [
        {
          title: "Prove the hook",
          objective: "Keep the active story visible across turns.",
          criteria: ["prompt context names the current story"],
        },
      ],
    });
    startNextUltragoalStory({
      cwd: root,
      sessionId: "goal-session",
      operationId: "story-start",
    });

    const output = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "continue" }),
    );

    expect(output.additionalContext).toContain("[ULTRAGOAL STORY G001]");
    expect(output.additionalContext).toContain("Prove the hook");
    expect(output.additionalContext).toContain("[ ] C001: prompt context names the current story");
  });

  it("does not inject an Ultragoal bound to an older Goal generation", async () => {
    const root = project();
    const goal = createGoal(root, "goal-session", "Original Goal");
    createUltragoal({
      cwd: root,
      sessionId: "goal-session",
      operationId: "plan-create",
      objective: "Original Goal",
      goalGeneration: goal.result.goalGeneration,
      stories: [
        {
          title: "Old story",
          objective: "This must not steer the replacement Goal.",
          criteria: ["old criterion"],
        },
      ],
    });
    startNextUltragoalStory({
      cwd: root,
      sessionId: "goal-session",
      operationId: "story-start",
    });
    goalCommand({
      root,
      command: "replace",
      sessionId: "goal-session",
      operationId: "goal-replace",
      objective: "Replacement Goal",
    });

    const output = await handlePromptSubmit(
      JSON.stringify({ cwd: root, sessionId: "goal-session", prompt: "continue" }),
    );

    expect(output.additionalContext).toContain("Replacement Goal");
    expect(output.additionalContext).not.toContain("[ULTRAGOAL STORY");
    expect(output.additionalContext).not.toContain("Old story");
  });

  it("SessionStart also drops Ultragoal bound to an older Goal generation", async () => {
    process.env.OMP_VERSION_OVERRIDE = "999.0.0";
    const root = project();
    const goal = createGoal(root, "goal-session", "Original Goal");
    createUltragoal({
      cwd: root,
      sessionId: "goal-session",
      operationId: "plan-create",
      objective: "Original Goal",
      goalGeneration: goal.result.goalGeneration,
      stories: [
        {
          title: "Old story",
          objective: "This must not steer the replacement Goal.",
          criteria: ["old criterion"],
        },
      ],
    });
    startNextUltragoalStory({
      cwd: root,
      sessionId: "goal-session",
      operationId: "story-start",
    });
    goalCommand({
      root,
      command: "replace",
      sessionId: "goal-session",
      operationId: "goal-replace",
      objective: "Replacement Goal",
    });

    const output = await handleSessionStart(
      JSON.stringify({ cwd: root, sessionId: "goal-session" }),
    );
    const context = output.additionalContext ?? "";

    expect(context).toContain("Replacement Goal");
    expect(context).not.toContain("[ULTRAGOAL STORY");
    expect(context).not.toContain("Old story");
  });

  it("does not inject global loop modes when Goal status is busy", async () => {
    const { createHash } = await import("node:crypto");
    const { openSync, closeSync, fsyncSync, writeFileSync: write } = await import("node:fs");
    const { randomUUID } = await import("node:crypto");
    // @ts-expect-error - plain .mjs hook script export.
    const { buildContinuationContext } = await import("../../scripts/prompt-submit.mjs");
    const root = project();
    createGoal(root, "goal-session");
    await startRalph({
      cwd: root,
      prompt: "global ralph should stay out",
      maxIterations: 3,
    });
    const key = createHash("sha256").update("goal-session", "utf8").digest("hex");
    const lockPath = join(root, ".omp", "state", "goals", key, "aggregate.lock");
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      write(
        fd,
        `${JSON.stringify({
          schemaVersion: 1,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token: randomUUID(),
        })}\n`,
        "utf8",
      );
      fsyncSync(fd);
      const context = buildContinuationContext(root, "goal-session");
      expect(context).not.toContain("[RALPH ACTIVE");
      expect(context).not.toContain("[ULTRAWORK ACTIVE");
      expect(context).not.toContain("[ULTRAQA ACTIVE");
    } finally {
      closeSync(fd);
    }
  });
});
