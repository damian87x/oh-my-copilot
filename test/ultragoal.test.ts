import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyUltragoalGate,
  attachUltragoalEvidence,
  checkpointUltragoalStory,
  createUltragoal,
  readUltragoal,
  startNextUltragoalStory,
  steerUltragoal,
  ultragoalPaths,
} from "../src/ultragoal/runtime.js";

const fixtures: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omp-ultragoal-"));
  fixtures.push(root);
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

function createPlan(root: string, operationId = "snapshot-1") {
  return createUltragoal({
    cwd: root,
    sessionId: "session-1",
    operationId,
    objective: "Ship the durable workflow",
    stories: [
      {
        title: "Build the runtime",
        objective: "Implement the runtime safely.",
        criteria: ["focused tests pass", "runtime evidence is recorded"],
      },
      {
        title: "Prove the integration",
        objective: "Run the supported live path.",
        criteria: ["live evidence is recorded"],
      },
    ],
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sequential Ultragoal", () => {
  it("snapshots a source, starts stories in order, and requires evidence for every criterion", () => {
    const root = project();
    const created = createPlan(root);
    const paths = ultragoalPaths(root, "session-1");

    expect(created).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      status: "active",
      objective: "Ship the durable workflow",
      activeStoryId: null,
      stories: [
        {
          id: "G001",
          status: "pending",
          criteria: [{ id: "C001" }, { id: "C002" }],
        },
        { id: "G002", status: "pending" },
      ],
      source: {
        kind: "objective",
        snapshotPath: expect.stringContaining(".omp/ultragoal"),
      },
    });
    expect(paths.manifest).toContain(created.sessionKey);

    const replay = createPlan(root);
    expect(replay.revision).toBe(1);
    expect(() => createPlan(root, "snapshot-1-different")).toThrow(/already exists/i);
    expect(() =>
      createUltragoal({
        cwd: root,
        sessionId: "session-1",
        operationId: "snapshot-1",
        objective: "Different input",
      }),
    ).toThrow(/OPERATION_COLLISION/);

    const first = startNextUltragoalStory({
      cwd: root,
      sessionId: "session-1",
      operationId: "start-1",
    });
    expect(first).toMatchObject({ revision: 2, activeStoryId: "G001" });
    expect(first.stories[0]).toMatchObject({ status: "in_progress", attempts: 1 });
    expect(
      startNextUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId: "start-1",
      }).revision,
    ).toBe(2);
    expect(() =>
      startNextUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId: "start-2",
      }),
    ).toThrow(/STORY_IN_PROGRESS/);

    const evidenceFile = join(root, "focused-test.txt");
    writeFileSync(evidenceFile, "2 tests passed\n", "utf8");
    attachUltragoalEvidence({
      cwd: root,
      sessionId: "session-1",
      operationId: "evidence-1",
      storyId: "G001",
      criterionId: "C001",
      file: "focused-test.txt",
      summary: "focused tests passed",
    });
    expect(() =>
      checkpointUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId: "complete-1",
        storyId: "G001",
      }),
    ).toThrow(/CRITERION_EVIDENCE_REQUIRED/);

    attachUltragoalEvidence({
      cwd: root,
      sessionId: "session-1",
      operationId: "evidence-2",
      storyId: "G001",
      criterionId: "C002",
      summary: "ledger contains the focused run",
    });
    const completed = checkpointUltragoalStory({
      cwd: root,
      sessionId: "session-1",
      operationId: "complete-2",
      storyId: "G001",
    });
    expect(completed).toMatchObject({
      activeStoryId: null,
      stories: [{ id: "G001", status: "complete" }, { id: "G002", status: "pending" }],
    });
    expect(
      startNextUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId: "start-3",
      }),
    ).toMatchObject({ activeStoryId: "G002" });
  });

  it("treats prototype-named operation IDs as ordinary owned records", () => {
    for (const operationId of ["constructor", "__proto__"]) {
      const root = project();
      createPlan(root);

      const started = startNextUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId,
      });
      const replay = startNextUltragoalStory({
        cwd: root,
        sessionId: "session-1",
        operationId,
      });

      expect(started).toMatchObject({ revision: 2, activeStoryId: "G001" });
      expect(replay).toEqual(started);
    }
  });

  it("rejects evidence paths outside the project and through symlinks", () => {
    const root = project();
    createPlan(root);
    startNextUltragoalStory({
      cwd: root,
      sessionId: "session-1",
      operationId: "start",
    });
    const outside = join(tmpdir(), `outside-${Date.now()}.txt`);
    writeFileSync(outside, "outside\n", "utf8");
    fixtures.push(outside);

    expect(() =>
      attachUltragoalEvidence({
        cwd: root,
        sessionId: "session-1",
        operationId: "outside",
        storyId: "G001",
        criterionId: "C001",
        file: outside,
        summary: "outside",
      }),
    ).toThrow(/EVIDENCE_PATH_INVALID/);

    const linked = join(root, "linked.txt");
    symlinkSync(outside, linked);
    expect(() =>
      attachUltragoalEvidence({
        cwd: root,
        sessionId: "session-1",
        operationId: "symlink",
        storyId: "G001",
        criterionId: "C001",
        file: "linked.txt",
        summary: "symlink",
      }),
    ).toThrow(/EVIDENCE_PATH_INVALID/);
  });

  it("rejects a changed source snapshot and malformed persisted IDs on reopen", () => {
    const sourceRoot = project();
    createPlan(sourceRoot);
    const sourcePaths = ultragoalPaths(sourceRoot, "session-1");
    writeFileSync(sourcePaths.brief, "# Ultragoal Brief\n\ntampered\n", "utf8");
    expect(() => readUltragoal(sourceRoot, "session-1")).toThrow(
      /SOURCE_SNAPSHOT_MISMATCH/,
    );

    const manifestRoot = project();
    createPlan(manifestRoot);
    const manifestPaths = ultragoalPaths(manifestRoot, "session-1");
    const manifest = JSON.parse(readFileSync(manifestPaths.manifest, "utf8"));
    manifest.stories[0].id = "../escape";
    writeFileSync(manifestPaths.manifest, JSON.stringify(manifest), "utf8");
    expect(() => readUltragoal(manifestRoot, "session-1")).toThrow(
      /MANIFEST_CORRUPT/,
    );
  });

  it("verifies the ledger hash chain before trusting a reopened manifest", () => {
    const root = project();
    createPlan(root);
    const paths = ultragoalPaths(root, "session-1");
    const entries = readFileSync(paths.ledger, "utf8").trim().split("\n");
    const first = JSON.parse(entries[0]!);
    first.payload = { storyIds: ["G999"] };
    entries[0] = JSON.stringify(first);
    writeFileSync(paths.ledger, `${entries.join("\n")}\n`, "utf8");

    expect(() => readUltragoal(root, "session-1")).toThrow(/LEDGER_CORRUPT/);
  });

  it("binds the latest ledger entry to the post-mutation manifest state", () => {
    const root = project();
    createPlan(root);
    const started = startNextUltragoalStory({
      cwd: root,
      sessionId: "session-1",
      operationId: "start-ledger-binding",
    });
    const paths = ultragoalPaths(root, "session-1");

    expect(readUltragoal(root, "session-1")).toEqual(started);

    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    manifest.stories[0].attempts += 1;
    writeFileSync(paths.manifest, JSON.stringify(manifest), "utf8");

    expect(() => readUltragoal(root, "session-1")).toThrow(
      /manifest state hash does not match the ledger/,
    );
  });

  it("recovers a validated pending mutation before reopening the plan", () => {
    const root = project();
    const created = createPlan(root);
    const paths = ultragoalPaths(root, "session-1");
    const ledgerEntry = JSON.parse(readFileSync(paths.ledger, "utf8").trim());
    writeFileSync(
      paths.pending,
      JSON.stringify({
        schemaVersion: 1,
        manifest: JSON.parse(readFileSync(paths.manifest, "utf8")),
        ledgerEntry,
      }),
      "utf8",
    );
    truncateSync(paths.ledger, 0);

    expect(readUltragoal(root, "session-1")).toMatchObject({
      revision: created.revision,
      planId: created.planId,
    });
    expect(JSON.parse(readFileSync(paths.ledger, "utf8").trim())).toEqual(ledgerEntry);
    expect(existsSync(paths.pending)).toBe(false);
  });

  it("recovers a pending mutation over a torn final ledger record", () => {
    const root = project();
    const created = createPlan(root);
    const paths = ultragoalPaths(root, "session-1");
    const ledgerEntry = JSON.parse(readFileSync(paths.ledger, "utf8").trim());
    writeFileSync(
      paths.pending,
      JSON.stringify({
        schemaVersion: 1,
        manifest: JSON.parse(readFileSync(paths.manifest, "utf8")),
        ledgerEntry,
      }),
      "utf8",
    );
    writeFileSync(
      paths.ledger,
      JSON.stringify(ledgerEntry).slice(0, 80),
      "utf8",
    );

    expect(readUltragoal(root, "session-1")).toMatchObject({
      revision: created.revision,
      planId: created.planId,
    });
    expect(JSON.parse(readFileSync(paths.ledger, "utf8").trim())).toEqual(ledgerEntry);
    expect(existsSync(paths.pending)).toBe(false);
  });

  it("recovers an Ultragoal lock whose owner process is dead", () => {
    const root = project();
    const created = createPlan(root);
    const paths = ultragoalPaths(root, "session-1");
    writeFileSync(
      paths.lock,
      JSON.stringify({
        pid: 999_999_999,
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );

    expect(readUltragoal(root, "session-1")).toMatchObject({
      planId: created.planId,
      revision: created.revision,
    });
    expect(existsSync(paths.lock)).toBe(false);
  });

  it("does not enter while a live stale-lock recovery claim exists", () => {
    const root = project();
    const created = createPlan(root);
    const paths = ultragoalPaths(root, "session-1");
    writeFileSync(
      paths.lock,
      JSON.stringify({
        pid: 999_999_999,
        acquiredAt: new Date().toISOString(),
        token: "stale",
      }),
      "utf8",
    );
    const claim = `${paths.lock}.recovery-${process.pid}-test`;
    linkSync(paths.lock, claim);

    expect(() => readUltragoal(root, "session-1")).toThrow(/ULTRAGOAL_BUSY/);
    unlinkSync(claim);
    expect(readUltragoal(root, "session-1")).toMatchObject({
      planId: created.planId,
      revision: created.revision,
    });
  });

  it("replays attached evidence after the original file is removed", () => {
    const root = project();
    createPlan(root);
    startNextUltragoalStory({
      cwd: root,
      sessionId: "session-1",
      operationId: "start-replay",
    });
    const evidenceFile = join(root, "ephemeral-evidence.txt");
    writeFileSync(evidenceFile, "focused test passed\n", "utf8");
    const input = {
      cwd: root,
      sessionId: "session-1",
      operationId: "evidence-replay",
      storyId: "G001",
      criterionId: "C001",
      summary: "focused test passed",
      file: "ephemeral-evidence.txt",
    };
    const attached = attachUltragoalEvidence(input);
    unlinkSync(evidenceFile);

    expect(attachUltragoalEvidence(input)).toEqual(attached);
  });

  it("rejects plans whose criteria cannot all fit under the evidence ceiling", () => {
    const root = project();
    const stories = Array.from({ length: 21 }, (_, storyIndex) => ({
      title: `Story ${storyIndex + 1}`,
      objective: `Complete story ${storyIndex + 1}.`,
      criteria: Array.from(
        { length: 50 },
        (_, criterionIndex) => `criterion ${storyIndex + 1}-${criterionIndex + 1}`,
      ),
    }));

    expect(() =>
      createUltragoal({
        cwd: root,
        sessionId: "session-1",
        operationId: "too-many-criteria",
        objective: "Impossible evidence plan",
        stories,
      }),
    ).toThrow(/TOO_MANY_CRITERIA/);
  });

  it("rejects a gate applied before every story is terminal", () => {
    const root = project();
    const plan = createPlan(root);

    expect(() =>
      applyUltragoalGate({
        cwd: root,
        sessionId: "session-1",
        operationId: "premature-gate",
        gate: {
          schemaVersion: 1,
          status: "blocked",
          planRevision: plan.revision,
          roles: [],
          createdAt: new Date().toISOString(),
          artifactPath: ".omp/ultragoal/premature.json",
        },
      }),
    ).toThrow(/GATE_NOT_READY/);
    expect(readUltragoal(root, "session-1")).toMatchObject({
      revision: plan.revision,
      status: "active",
    });
  });

  it("does not let blocked-gate resolver stories exceed the total criteria ceiling", () => {
    const root = project();
    const stories = Array.from({ length: 20 }, (_, storyIndex) => ({
      title: `Story ${storyIndex + 1}`,
      objective: `Complete story ${storyIndex + 1}.`,
      criteria: Array.from(
        { length: 50 },
        (_, criterionIndex) => `criterion ${storyIndex + 1}-${criterionIndex + 1}`,
      ),
    }));
    createUltragoal({
      cwd: root,
      sessionId: "session-1",
      operationId: "capacity-create",
      objective: "Capacity-bound plan",
      stories,
    });
    for (let index = 1; index <= stories.length; index += 1) {
      steerUltragoal({
        cwd: root,
        sessionId: "session-1",
        operationId: `supersede-${index}`,
        kind: "supersede",
        evidence: "The story no longer applies.",
        rationale: "Prepare the final blocked-gate capacity boundary.",
        targetStoryId: `G${String(index).padStart(3, "0")}`,
      });
    }
    const ready = readUltragoal(root, "session-1");
    expect(ready.status).toBe("awaiting_gate");

    expect(() =>
      applyUltragoalGate({
        cwd: root,
        sessionId: "session-1",
        operationId: "capacity-gate",
        gate: {
          schemaVersion: 1,
          status: "blocked",
          planRevision: ready.revision,
          roles: [
            {
              role: "architect",
              verdict: "BLOCK",
              planRevision: ready.revision,
              summary: "one resolver is required",
              outputPath: ".omp/ultragoal/architect.txt",
              outputSha256: "0".repeat(64),
              exitCode: 0,
              timedOut: false,
              overflowed: false,
            },
          ],
          createdAt: new Date().toISOString(),
          artifactPath: ".omp/ultragoal/capacity.json",
        },
      }),
    ).toThrow(/TOO_MANY_CRITERIA/);
    expect(readUltragoal(root, "session-1")).toMatchObject({
      revision: ready.revision,
      status: "awaiting_gate",
    });
  });

  it("audits explicit steering, preserves completed stories, and invalidates prior gates", () => {
    const root = project();
    createPlan(root);
    const added = steerUltragoal({
      cwd: root,
      sessionId: "session-1",
      operationId: "steer-add",
      kind: "add",
      evidence: "A newly discovered compatibility check is required.",
      rationale: "The final integration depends on this check.",
      stories: [
        {
          title: "Check compatibility",
          objective: "Prove compatibility before live acceptance.",
          criteria: ["compatibility evidence is recorded"],
        },
      ],
    });
    expect(added).toMatchObject({
      revision: 2,
      stories: [{ id: "G001" }, { id: "G002" }, { id: "G003", status: "pending" }],
    });

    const reordered = steerUltragoal({
      cwd: root,
      sessionId: "session-1",
      operationId: "steer-order",
      kind: "reorder",
      evidence: "Compatibility must precede integration.",
      rationale: "Fail fast before the live run.",
      pendingOrder: ["G001", "G003", "G002"],
    });
    expect(reordered.stories.map((story) => story.id)).toEqual(["G001", "G003", "G002"]);
    expect(readUltragoal(root, "session-1").revision).toBe(3);
  });

  it("supersedes a plan bound to an older Goal generation on create", () => {
    const root = project();
    const oldGeneration = "a".repeat(64);
    const newGeneration = "b".repeat(64);
    const first = createUltragoal({
      cwd: root,
      sessionId: "session-1",
      operationId: "plan-old",
      objective: "Original objective",
      goalGeneration: oldGeneration,
      stories: [
        {
          title: "Old story",
          objective: "Bound to the previous Goal generation.",
          criteria: ["old criterion"],
        },
      ],
    });
    expect(first.goalGeneration).toBe(oldGeneration);
    expect(first.stories[0]?.id).toBe("G001");

    const second = createUltragoal({
      cwd: root,
      sessionId: "session-1",
      operationId: "plan-new",
      objective: "Replacement objective",
      goalGeneration: newGeneration,
      stories: [
        {
          title: "New story",
          objective: "Bound to the current Goal generation.",
          criteria: ["new criterion"],
        },
      ],
    });
    expect(second.goalGeneration).toBe(newGeneration);
    expect(second.planId).not.toBe(first.planId);
    expect(second.objective).toBe("Replacement objective");
    expect(second.stories.map((story) => story.title)).toEqual(["New story"]);
    expect(readUltragoal(root, "session-1").revision).toBe(1);

    expect(() =>
      createUltragoal({
        cwd: root,
        sessionId: "session-1",
        operationId: "plan-same-generation",
        objective: "Still current generation",
        goalGeneration: newGeneration,
        stories: [
          {
            title: "Duplicate",
            objective: "Must not replace the current generation plan.",
            criteria: ["should fail"],
          },
        ],
      }),
    ).toThrow(/already exists/i);
  });

});
