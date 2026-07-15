import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveDesignGate,
  canRunDesignSession,
  editFrozenDesignSpec,
  freezeReviewedManifestV1,
  freezeDesignSession,
  loadDesignSession,
  nextDesignGate,
  startDesignSession,
} from "../../src/skill-bench/design.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omp-skill-bench-design-"));
  home = mkdtempSync(path.join(tmpdir(), "omp-skill-bench-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("skill-bench guided/direct pair design state", () => {
  it("freezes experiment content without implicitly approving live spend", () => {
    expect(freezeReviewedManifestV1({ id: "spec-a", status: "draft" })).toMatchObject({
      status: "frozen",
      approvals: { frozen: true, budget: true, liveCellsAllowed: false },
    });
  });

  it("starts history-guided drafts with 30d/all, direct drafts bypass history ranking, and both use identical approval gates", () => {
    const guided = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    const direct = startDesignSession({ rootDir: root, mode: "direct", skillName: "tdd", directPath: "/tmp/skill/SKILL.md" });

    expect(guided.historyWindow).toEqual({ window: "30d", project: "all" });
    expect(guided.usedHistoryRanking).toBe(true);
    expect(direct.historyWindow).toBeUndefined();
    expect(direct.usedHistoryRanking).toBe(false);
    expect(direct.directPath).toBe("/tmp/skill/SKILL.md");
    expect(guided.gates).toEqual(direct.gates);
    expect(nextDesignGate(guided)?.id).toBe("selection");
    expect(readFileSync(guided.statePath, "utf8")).toContain('"status":"draft"');
  });



  it("persists guided command history filters without affecting direct mode", () => {
    const guided = startDesignSession({
      rootDir: root,
      mode: "guided",
      skillName: "tdd",
      historyWindow: { window: "7d", project: "current" },
    });
    const direct = startDesignSession({
      rootDir: root,
      mode: "direct",
      skillName: "tdd",
      directPath: "/tmp/skill/SKILL.md",
      historyWindow: { window: "90d", project: "current" },
    });

    expect(guided.historyWindow).toEqual({ window: "7d", project: "current" });
    expect(guided.spec.historyWindow).toEqual({ window: "7d", project: "current" });
    expect(loadDesignSession(guided.statePath).spec.historyWindow).toEqual({ window: "7d", project: "current" });
    expect(direct.historyWindow).toBeUndefined();
    expect(direct.spec.historyWindow).toBeUndefined();
  });

  it("persists model, judge, execution profile, and hard budget review metadata in guided and direct design sessions", () => {
    const guided = startDesignSession({
      rootDir: root,
      mode: "guided",
      skillName: "tdd",
      models: { candidateModelIds: ["gpt-5.5", "gpt-5.6-luna"], selectedModelIds: ["gpt-5.5"], judgeModelIds: ["judge-model"] },
      executionProfile: "normal-project",
      hardBudgetCeilings: { maxUsd: 5, maxCells: 10, maxRuntimeMinutes: 20 },
    });
    const direct = startDesignSession({
      rootDir: root,
      mode: "direct",
      skillName: "review",
      directPath: "/tmp/skill/SKILL.md",
      models: { selectedModelIds: ["gpt-safe"], judgeModelIds: ["judge-safe"] },
      executionProfile: "custom",
      hardBudgetCeilings: { maxPremiumRequests: 2 },
    });

    expect(loadDesignSession(guided.statePath)).toMatchObject({
      models: { candidateModelIds: ["gpt-5.5", "gpt-5.6-luna"], selectedModelIds: ["gpt-5.5"], judgeModelIds: ["judge-model"] },
      executionProfile: "normal-project",
      hardBudgetCeilings: { maxUsd: 5, maxCells: 10, maxRuntimeMinutes: 20 },
      spec: {
        models: { candidateModelIds: ["gpt-5.5", "gpt-5.6-luna"], selectedModelIds: ["gpt-5.5"], judgeModelIds: ["judge-model"] },
        executionProfile: "normal-project",
        hardBudgetCeilings: { maxUsd: 5, maxCells: 10, maxRuntimeMinutes: 20 },
      },
    });
    expect(loadDesignSession(direct.statePath)).toMatchObject({
      models: { candidateModelIds: ["gpt-safe"], selectedModelIds: ["gpt-safe"], judgeModelIds: ["judge-safe"] },
      executionProfile: "custom",
      hardBudgetCeilings: { maxPremiumRequests: 2 },
    });
  });

  it("uses shared project and injected-home skill-bench roots for design state", () => {
    writeFileSync(path.join(root, "package.json"), "{}\n");
    const nested = path.join(root, "nested", "app");
    mkdirSync(nested, { recursive: true });

    const projectSession = startDesignSession({ rootDir: nested, homeDir: home, mode: "guided", skillName: "tdd" });
    expect(projectSession.statePath.startsWith(path.join(root, ".omp", "skill-bench", "design"))).toBe(true);
    expect(existsSync(projectSession.statePath)).toBe(true);

    const userSession = startDesignSession({ rootDir: nested, homeDir: home, storageScope: "global", mode: "guided", skillName: "tdd" });
    expect(userSession.statePath.startsWith(path.join(home, ".omp", "skill-bench", "design"))).toBe(true);
    expect(userSession.statePath).not.toContain("skill-bench-global");
    expect(existsSync(userSession.statePath)).toBe(true);
  });

  it("saves after each append-only hash-bound approval and freezes only after all gates are approved", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    session = approveDesignGate(session, "selection", { selectedSkill: "tdd" });
    session = approveDesignGate(session, "scenarios", { scenarioIds: ["detect"] });

    const reloaded = loadDesignSession(session.statePath);
    expect(reloaded.approvals.map((approval) => approval.gateId)).toEqual(["selection", "scenarios"]);
    expect(reloaded.approvals[0].specHash).toBe(reloaded.approvals[1].specHash);
    expect(reloaded.spec).not.toHaveProperty("approvals");
    expect(() => approveDesignGate(reloaded, "selection", { selectedSkill: "other" })).toThrow(/append-only/);
    expect(() => freezeDesignSession(reloaded)).toThrow(/missing approvals/);

    for (const gate of reloaded.gates.slice(2)) session = approveDesignGate(session, gate.id, { ok: true });
    session = freezeDesignSession(session);
    expect(session.status).toBe("frozen");
    expect(canRunDesignSession(session)).toBe(true);
    expect(loadDesignSession(session.statePath).freeze?.invalidated).toBe(false);
  });



  it("keeps approval hashes stable across all gates and invalidates freeze only after spec edits", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });

    expect(new Set(session.approvals.map((approval) => approval.specHash)).size).toBe(1);
    session = freezeDesignSession(session);
    const originalFreezeHash = session.freeze?.specHash;
    expect(canRunDesignSession(session)).toBe(true);

    const edited = editFrozenDesignSpec(session, (spec) => ({ ...spec, historyWindow: { window: "90d", project: "current" } }));
    expect(edited.freeze?.specHash).toBe(originalFreezeHash);
    expect(edited.freeze?.invalidated).toBe(true);
    expect(canRunDesignSession(edited)).toBe(false);
  });

  it("changes approval and freeze hashes when reviewed model selection changes", () => {
    let session = startDesignSession({
      rootDir: root,
      mode: "guided",
      skillName: "tdd",
      models: { selectedModelIds: ["gpt-a"], judgeModelIds: ["judge-a"] },
      executionProfile: "restricted",
      hardBudgetCeilings: { maxUsd: 1 },
    });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });
    const originalApprovalHash = session.approvals[0].specHash;
    session = freezeDesignSession(session);
    const originalFreezeHash = session.freeze?.specHash;

    session = editFrozenDesignSpec(session, (spec) => ({
      ...spec,
      models: { ...spec.models, candidateModelIds: ["gpt-a", "gpt-b"], selectedModelIds: ["gpt-b"] },
    }));

    expect(session.models.selectedModelIds).toEqual(["gpt-b"]);
    expect(session.freeze?.specHash).toBe(originalFreezeHash);
    expect(session.freeze?.invalidated).toBe(true);
    expect(() => freezeDesignSession(session)).toThrow(/stale approvals/);

    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { reapproved: gate.id });
    const editedApprovalHash = session.approvals.at(-1)?.specHash;
    expect(editedApprovalHash).not.toBe(originalApprovalHash);
    session = freezeDesignSession(session);
    expect(session.freeze?.specHash).toBe(editedApprovalHash);
    expect(session.freeze?.specHash).not.toBe(originalFreezeHash);
  });



  it("blocks freeze after editing a frozen spec until every gate is reapproved for the new hash", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });
    const originalApprovalHash = session.approvals[0].specHash;
    session = freezeDesignSession(session);

    session = editFrozenDesignSpec(session, (spec) => ({ ...spec, historyWindow: { window: "90d", project: "current" } }));
    expect(session.status).toBe("draft");
    expect(session.approvals).toHaveLength(session.gates.length);
    expect(session.approvals.every((approval) => approval.specHash === originalApprovalHash)).toBe(true);
    expect(() => freezeDesignSession(session)).toThrow(/stale approvals/);

    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { reapproved: gate.id });
    const editedApprovalHash = session.approvals.at(-1)?.specHash;
    expect(editedApprovalHash).not.toBe(originalApprovalHash);
    expect(new Set(session.approvals.map((approval) => approval.specHash))).toEqual(new Set([originalApprovalHash, editedApprovalHash]));
    expect(session.approvals.filter((approval) => approval.specHash === editedApprovalHash)).toHaveLength(session.gates.length);

    session = freezeDesignSession(session);
    expect(session.status).toBe("frozen");
    expect(session.freeze?.specHash).toBe(editedApprovalHash);
    expect(canRunDesignSession(session)).toBe(true);
  });

  it("treats stale approval hashes as missing and stops noninteractive JSON freeze attempts", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd", noninteractive: true, json: true });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });
    const staleHash = session.approvals[0].specHash;
    const staleSession = loadDesignSession(session.statePath);
    staleSession.spec = { ...staleSession.spec, skillName: "changed" };
    writeFileSync(staleSession.statePath, JSON.stringify(staleSession));

    const reloaded = loadDesignSession(staleSession.statePath);
    expect(reloaded.approvals.every((approval) => approval.specHash === staleHash)).toBe(true);
    expect(() => freezeDesignSession(reloaded)).toThrow(/stale approvals/);

    const stopped = freezeDesignSession(reloaded, { saveAndStopIfMissingApprovals: true });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toContain("stale approvals");
  });


  it("keeps stale approval history in an append-only ledger and reapproval appends current entries", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });
    const originalHash = session.approvals[0].specHash;
    session = freezeDesignSession(session);

    session = editFrozenDesignSpec(session, (spec) => ({ ...spec, historyWindow: { window: "90d", project: "current" } }));
    const editedHash = session.approvals[0].specHash;
    expect(editedHash).toBe(originalHash);
    expect(session.approvals).toHaveLength(session.gates.length);
    expect(() => freezeDesignSession(session)).toThrow(/stale approvals/);

    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { reapproved: gate.id });
    const currentHash = session.approvals.at(-1)?.specHash;
    expect(currentHash).not.toBe(originalHash);
    expect(session.approvals).toHaveLength(session.gates.length * 2);

    const ledger = readFileSync(path.join(path.dirname(session.statePath), "approvals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const approvalEvents = ledger.filter((event) => event.type === "approval");
    expect(approvalEvents).toHaveLength(session.gates.length * 2);
    expect(approvalEvents.filter((event) => event.status === "current")).toHaveLength(session.gates.length * 2);
    expect(ledger.find((event) => event.type === "edit" && event.status === "stale")).toMatchObject({
      type: "edit",
      stage: "edit",
      artifactHash: currentHash,
      specHash: currentHash,
      previousSpecHash: originalHash,
      status: "stale",
      staleGateIds: session.gates.map((gate) => gate.id),
      scope: "project",
      rootDir: root,
      source: "editFrozenDesignSpec",
    });
    expect(approvalEvents[0]).toMatchObject({
      type: "approval",
      stage: "selection",
      gateId: "selection",
      artifactHash: originalHash,
      specHash: originalHash,
      status: "current",
      scope: "project",
      rootDir: root,
      source: "approveDesignGate",
    });
    expect(approvalEvents.at(-1)).toMatchObject({
      type: "approval",
      stage: "budgets",
      gateId: "budgets",
      artifactHash: currentHash,
      specHash: currentHash,
      status: "current",
      scope: "project",
      rootDir: root,
      source: "approveDesignGate",
    });
    expect(approvalEvents.every((event) => typeof event.timestamp === "string" && event.timestamp.length > 0)).toBe(true);
  });

  it("logs freeze success, stale freeze refusal, and edit invalidation events", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd", noninteractive: true, json: true });
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { approved: gate.id });
    const originalHash = session.approvals[0].specHash;
    session = freezeDesignSession(session);
    session = editFrozenDesignSpec(session, (spec) => ({ ...spec, skillName: "changed" }));
    expect(session.approvals[0].specHash).toBe(originalHash);

    const stopped = freezeDesignSession(session, { saveAndStopIfMissingApprovals: true });
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toContain("stale approvals");

    const ledger = readFileSync(path.join(path.dirname(stopped.statePath), "approvals.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(ledger.find((event) => event.type === "freeze" && event.status === "current")).toMatchObject({
      type: "freeze",
      stage: "freeze",
      artifactHash: originalHash,
      specHash: originalHash,
      status: "current",
      scope: "project",
      rootDir: root,
      source: "freezeDesignSession",
    });
    const editEvent = ledger.find((event) => event.type === "edit" && event.status === "stale");
    expect(editEvent).toMatchObject({
      type: "edit",
      stage: "edit",
      previousSpecHash: originalHash,
      status: "stale",
      staleGateIds: session.gates.map((gate) => gate.id),
      source: "editFrozenDesignSpec",
    });
    expect(editEvent.artifactHash).toBe(editEvent.specHash);
    expect(editEvent.artifactHash).not.toBe(originalHash);
    expect(ledger.find((event) => event.type === "freeze" && event.status === "stale")).toMatchObject({
      type: "freeze",
      stage: "freeze",
      artifactHash: editEvent.artifactHash,
      specHash: editEvent.specHash,
      status: "stale",
      source: "freezeDesignSession",
    });
  });

  it("preserves approval hashes only when an edit leaves spec content unchanged", () => {
    let session = startDesignSession({ rootDir: root, mode: "direct", skillName: "review", directPath: "/tmp/skill/SKILL.md" });
    session = approveDesignGate(session, "selection", { selectedSkill: "review" });
    const approvalHash = session.approvals[0].specHash;

    session = editFrozenDesignSpec(session, (spec) => ({ ...spec }));
    expect(session.approvals[0].specHash).toBe(approvalHash);

    session = editFrozenDesignSpec(session, (spec) => ({ ...spec, directPath: "/tmp/skill-v2/SKILL.md" }));
    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].specHash).toBe(approvalHash);
    expect(() => freezeDesignSession(session)).toThrow(/stale approvals/);
    session = approveDesignGate(session, "selection", { selectedSkill: "review" });
    expect(session.approvals.at(-1)?.specHash).not.toBe(approvalHash);
  });


  it("requires generated references to be approved and saves/stops in noninteractive JSON when approvals are missing", () => {
    let session = startDesignSession({ rootDir: root, mode: "direct", skillName: "review", generatedReferences: true, noninteractive: true, json: true });
    expect(() => freezeDesignSession(session)).toThrow(/generated references require approval/);
    session = approveDesignGate(session, "selection", { selectedSkill: "review" });
    const attempted = freezeDesignSession(session, { saveAndStopIfMissingApprovals: true });

    expect(attempted.status).toBe("stopped");
    expect(attempted.stopReason).toContain("missing approvals");
    expect(loadDesignSession(attempted.statePath).status).toBe("stopped");
  });

  it("prevents run before freeze and invalidates immutable frozen specs when edited", () => {
    let session = startDesignSession({ rootDir: root, mode: "guided", skillName: "tdd" });
    expect(canRunDesignSession(session)).toBe(false);
    for (const gate of session.gates) session = approveDesignGate(session, gate.id, { ok: true });
    session = freezeDesignSession(session);
    expect(() => approveDesignGate(session, "selection", { ok: false })).toThrow(/frozen/);

    const edited = editFrozenDesignSpec(session, (spec) => ({ ...spec, skillName: "changed" }));
    expect(edited.status).toBe("draft");
    expect(edited.freeze?.invalidated).toBe(true);
    expect(canRunDesignSession(edited)).toBe(false);
  });
});
