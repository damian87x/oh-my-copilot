import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachUltragoalEvidence,
  checkpointUltragoalStory,
  createUltragoal,
  readUltragoal,
  startNextUltragoalStory,
} from "../src/ultragoal/runtime.js";
import {
  createDefaultGateSpawn,
  parseGateFooter,
  runUltragoalGate,
  type GateSpawn,
} from "../src/ultragoal/gates.js";
// @ts-expect-error - the hook runtime is intentionally plain ESM.
import { goalCommand } from "../scripts/lib/goal-runtime.mjs";

const fixtures: string[] = [];

function completedPlan(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-ultragoal-gate-"));
  fixtures.push(root);
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  const createdGoal = goalCommand({
    root,
    command: "set",
    sessionId: "session-1",
    operationId: "goal-create",
    objective: "Ship safely",
  });
  if (!createdGoal.ok) {
    throw new Error("Goal fixture could not create its outer Goal");
  }
  const goal = goalCommand({ root, command: "status", sessionId: "session-1" });
  if (!goal.ok || typeof goal.result.goalGeneration !== "string") {
    throw new Error("Goal fixture did not expose its generation");
  }
  createUltragoal({
    cwd: root,
    sessionId: "session-1",
    operationId: "create",
    objective: "Ship safely",
    goalGeneration: goal.result.goalGeneration,
    stories: [
      {
        title: "Ship",
        objective: "Implement and verify.",
        criteria: ["verification evidence exists"],
      },
    ],
  });
  startNextUltragoalStory({ cwd: root, sessionId: "session-1", operationId: "start" });
  writeFileSync(
    join(root, "verification.txt"),
    'vitest: 1235 passed\nbuild: passed\nlint: passed\napi_key="EVIDENCE_SECRET_1234567890"\n',
    "utf8",
  );
  attachUltragoalEvidence({
    cwd: root,
    sessionId: "session-1",
    operationId: "evidence",
    storyId: "G001",
    criterionId: "C001",
    summary: "focused and full tests passed",
    file: "verification.txt",
  });
  checkpointUltragoalStory({
    cwd: root,
    sessionId: "session-1",
    operationId: "checkpoint",
    storyId: "G001",
  });
  return root;
}

function spawnWith(
  verdicts: Partial<Record<"verifier" | "code-reviewer" | "architect", "PASS" | "BLOCK" | "INCONCLUSIVE">>,
): GateSpawn {
  return async ({ role, planRevision }) => {
    const verdict = verdicts[role] ?? "PASS";
    return {
      stdout: [
        `${role} inspected the bounded gate packet.`,
        `OMP_GATE_RESULT ${JSON.stringify({
          role,
          verdict,
          planRevision,
          summary: `${role} ${verdict.toLowerCase()}`,
        })}`,
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      overflowed: false,
    };
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Ultragoal three-role gate", () => {
  it("requires PASS from distinct verifier, code-reviewer, and architect processes at one revision", async () => {
    const root = completedPlan();
    const before = readUltragoal(root, "session-1");

    const gate = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-1",
        timeoutMs: 1_000,
      },
      { spawn: spawnWith({}) },
    );

    expect(gate).toMatchObject({
      status: "passed",
      planRevision: before.revision,
      roles: [
        { role: "verifier", verdict: "PASS" },
        { role: "code-reviewer", verdict: "PASS" },
        { role: "architect", verdict: "PASS" },
      ],
    });
    expect(new Set(gate.roles.map((role) => role.role)).size).toBe(3);
    expect(Object.keys(gate.roles[0]!).sort()).toEqual([
      "exitCode",
      "outputPath",
      "outputSha256",
      "overflowed",
      "planRevision",
      "role",
      "summary",
      "timedOut",
      "verdict",
    ]);
    const artifact = JSON.parse(readFileSync(join(root, gate.artifactPath), "utf8"));
    expect(artifact.roles[0]).not.toHaveProperty("stdout");
    expect(artifact.roles[0]).not.toHaveProperty("stderr");
    expect(readUltragoal(root, "session-1")).toMatchObject({
      status: "complete",
      lastGate: { status: "passed", planRevision: before.revision },
    });
    expect(
      goalCommand({ root, command: "status", sessionId: "session-1" }),
    ).toMatchObject({
      ok: true,
      result: { status: "complete", terminalReason: "assistant-complete" },
    });
  });

  it("supplies the recorded evidence file content to every bounded role prompt", async () => {
    const root = completedPlan();
    const prompts: string[] = [];

    await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-evidence",
      },
      {
        spawn: async (request) => {
          prompts.push(request.prompt);
          return spawnWith({})(request);
        },
      },
    );

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("RECORDED EVIDENCE CONTENT:");
      expect(prompt).toContain("vitest: 1235 passed");
      expect(prompt).toContain("build: passed");
      expect(prompt).toContain("[REDACTED]");
      expect(prompt).not.toContain("EVIDENCE_SECRET_1234567890");
    }
  });

  it("persists each full gate prompt and gives the spawn a bounded file reference", async () => {
    const root = completedPlan();
    const requests: Array<{ prompt: string; promptFile?: string }> = [];

    await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-prompt-file",
      },
      {
        spawn: async (request) => {
          requests.push(request);
          return spawnWith({})(request);
        },
      },
    );

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.promptFile).toMatch(/^\.omp\/ultragoal\//);
      expect(readFileSync(join(root, request.promptFile!), "utf8")).toBe(request.prompt);
    }
  });

  it("supplies staged and bounded non-ignored untracked changes to every role prompt", async () => {
    const root = completedPlan();
    writeFileSync(join(root, ".gitignore"), ".omp/\nignored-secret.txt\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Gate Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "gate@example.invalid"], { cwd: root });
    execFileSync("git", ["add", "package.json", "verification.txt", ".gitignore"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
    writeFileSync(
      join(root, "package.json"),
      'trackedGateMarker=review-this-change\ntoken="TRACKED_SECRET_1234567890"\n',
      "utf8",
    );
    execFileSync("git", ["add", "package.json"], { cwd: root });
    writeFileSync(
      join(root, "new-goal-runtime.ts"),
      'export const UNTRACKED_GATE_MARKER = "review-this-new-runtime";\n"api_key": "UNTRACKED_SECRET_1234567890"\n',
      "utf8",
    );
    for (const name of ["a-large.txt", "b-large.txt", "c-large.txt"]) {
      writeFileSync(join(root, name), `${name}\n${"x".repeat(4 * 1024)}\n`, "utf8");
    }
    writeFileSync(join(root, "z-small.txt"), "LATE_SMALL_FILE_MUST_APPEAR\n", "utf8");
    writeFileSync(
      join(root, "ignored-secret.txt"),
      "IGNORED_GATE_SECRET_MUST_NOT_APPEAR\n",
      "utf8",
    );
    const prompts: string[] = [];

    await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-untracked",
      },
      {
        spawn: async (request) => {
          prompts.push(request.prompt);
          return spawnWith({})(request);
        },
      },
    );

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("\nTRACKED FILE INVENTORY:\n");
      expect(prompt).toContain("package.json");
      expect(prompt).toContain("trackedGateMarker");
      expect(prompt).toContain("UNTRACKED FILE INVENTORY:");
      expect(prompt).toContain("new-goal-runtime.ts");
      expect(prompt).toContain("UNTRACKED_GATE_MARKER");
      expect(prompt).toContain("LATE_SMALL_FILE_MUST_APPEAR");
      expect(prompt).toContain("available read-only");
      expect(prompt).not.toContain("IGNORED_GATE_SECRET_MUST_NOT_APPEAR");
      expect(prompt).not.toContain("TRACKED_SECRET_1234567890");
      expect(prompt).not.toContain("UNTRACKED_SECRET_1234567890");
      expect(prompt).toContain("[REDACTED]");
    }
  });

  it("keeps the full prompt out of argv when a prompt file is available", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child);
    const gateSpawn = createDefaultGateSpawn(spawn as never);
    const hugePrompt = "x".repeat(180 * 1024);
    const pending = gateSpawn({
      role: "verifier",
      planRevision: 7,
      prompt: hugePrompt,
      promptFile: ".omp/ultragoal/session/gates/revision-7-verifier-prompt.txt",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      copilotBin: "/bin/echo",
      pluginRoot: process.cwd(),
    });
    queueMicrotask(() => child.emit("close", 0));

    await pending;

    const args = spawn.mock.calls[0]![1] as string[];
    const promptArg = args[args.indexOf("-p") + 1]!;
    expect(Buffer.byteLength(promptArg, "utf8")).toBeLessThan(1_024);
    expect(promptArg).toContain("revision-7-verifier-prompt.txt");
    expect(promptArg).not.toContain(hugePrompt.slice(0, 100));
  });

  it("escalates a timed-out gate child to SIGKILL and settles after the grace period", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    const gateSpawn = createDefaultGateSpawn(vi.fn(() => child) as never);
    const pending = gateSpawn({
      role: "architect",
      planRevision: 9,
      prompt: "review",
      promptFile: ".omp/ultragoal/session/gates/revision-9-architect-prompt.txt",
      cwd: process.cwd(),
      timeoutMs: 10,
      copilotBin: "/bin/echo",
      pluginRoot: process.cwd(),
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(pending).resolves.toMatchObject({
      timedOut: true,
      exitCode: 124,
    });
  });

  it("does not let recovery of an old passed gate complete a newer Goal", async () => {
    const root = completedPlan();
    await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-old-goal",
      },
      { spawn: spawnWith({}) },
    );
    goalCommand({
      root,
      command: "set",
      sessionId: "session-1",
      operationId: "new-goal",
      objective: "A newer objective",
    });

    await expect(
      runUltragoalGate(
        {
          cwd: root,
          sessionId: "session-1",
          operationId: "gate-recovery",
        },
        { spawn: spawnWith({}) },
      ),
    ).rejects.toThrow(/GOAL_COMPLETION_FAILED/);
    expect(
      goalCommand({ root, command: "status", sessionId: "session-1" }),
    ).toMatchObject({
      ok: true,
      result: { status: "active", objective: "A newer objective" },
    });
  });

  it("turns BLOCK and INCONCLUSIVE outcomes into deterministic pending resolver stories", async () => {
    const root = completedPlan();
    const before = readUltragoal(root, "session-1");

    const gate = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-blocked",
      },
      {
        spawn: spawnWith({
          "code-reviewer": "BLOCK",
          architect: "INCONCLUSIVE",
        }),
      },
    );
    const plan = readUltragoal(root, "session-1");

    expect(gate.status).toBe("blocked");
    expect(plan.status).toBe("active");
    expect(
      goalCommand({ root, command: "status", sessionId: "session-1" }),
    ).toMatchObject({
      ok: true,
      result: { status: "active" },
    });
    expect(plan.revision).toBe(before.revision + 1);
    expect(plan.stories.slice(-2)).toMatchObject([
      {
        status: "pending",
        criteria: [
          {
            text: "The reported code-reviewer issue is resolved with recorded evidence for a new gate",
          },
        ],
        resolver: { role: "code-reviewer", gateRevision: before.revision },
      },
      {
        status: "pending",
        criteria: [
          {
            text: "The reported architect issue is resolved with recorded evidence for a new gate",
          },
        ],
        resolver: { role: "architect", gateRevision: before.revision },
      },
    ]);
  });

  it("replays a recorded blocked gate without respawning roles or duplicating resolvers", async () => {
    const root = completedPlan();
    const first = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-replay",
      },
      { spawn: spawnWith({ architect: "BLOCK" }) },
    );
    const afterFirst = readUltragoal(root, "session-1");

    const replay = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-replay",
      },
      {
        spawn: async () => {
          throw new Error("replayed gates must not spawn");
        },
      },
    );

    expect(replay).toEqual(first);
    expect(readUltragoal(root, "session-1").stories).toHaveLength(
      afterFirst.stories.length,
    );
  });

  it("rejects replay when a persisted role output no longer matches its hash", async () => {
    const root = completedPlan();
    const first = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-tamper",
      },
      { spawn: spawnWith({ architect: "BLOCK" }) },
    );
    writeFileSync(join(root, first.roles[0]!.outputPath), "tampered\n", "utf8");

    await expect(
      runUltragoalGate(
        {
          cwd: root,
          sessionId: "session-1",
          operationId: "gate-tamper",
        },
        { spawn: spawnWith({}) },
      ),
    ).rejects.toThrow(/GATE_REPLAY_CORRUPT/);
  });

  it("persists timeout, overflow, and nonzero exits as bounded INCONCLUSIVE records", async () => {
    const root = completedPlan();
    const gate = await runUltragoalGate(
      {
        cwd: root,
        sessionId: "session-1",
        operationId: "gate-process-failures",
      },
      {
        spawn: async ({ role }) => ({
          stdout: `${role} partial output`,
          stderr: `${role} diagnostic`,
          exitCode: role === "architect" ? 7 : 1,
          timedOut: role === "verifier",
          overflowed: role === "code-reviewer",
        }),
      },
    );

    expect(gate.roles).toMatchObject([
      { role: "verifier", verdict: "INCONCLUSIVE", timedOut: true },
      { role: "code-reviewer", verdict: "INCONCLUSIVE", overflowed: true },
      { role: "architect", verdict: "INCONCLUSIVE", exitCode: 7 },
    ]);
    for (const role of gate.roles) {
      expect(role).not.toHaveProperty("stdout");
      expect(role).not.toHaveProperty("stderr");
      expect(readFileSync(join(root, role.outputPath), "utf8")).toContain(
        `${role.role} partial output`,
      );
    }
  });

  it("rejects stale, wrong-role, or non-final footers", () => {
    expect(() =>
      parseGateFooter(
        'OMP_GATE_RESULT {"role":"architect","verdict":"PASS","planRevision":4,"summary":"ok"}',
        "verifier",
        4,
      ),
    ).toThrow(/role/i);
    expect(() =>
      parseGateFooter(
        'OMP_GATE_RESULT {"role":"verifier","verdict":"PASS","planRevision":3,"summary":"ok"}',
        "verifier",
        4,
      ),
    ).toThrow(/revision/i);
    expect(() =>
      parseGateFooter(
        'OMP_GATE_RESULT {"role":"verifier","verdict":"PASS","planRevision":4,"summary":"ok"}\nextra',
        "verifier",
        4,
      ),
    ).toThrow(/final/i);
  });
});
