import { closeSync, constants, fsyncSync, ftruncateSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openRegularFile, writeAllSync } from "../utils/fs.js";
import { specContentHash, stableHash } from "./types.js";
import { resolveSkillBenchPaths, writeSkillBenchJsonAtomic, type SkillBenchPaths, type SkillBenchScope } from "./paths.js";

export type DesignMode = "guided" | "direct";
export type DesignStatus = "draft" | "stopped" | "frozen";

export interface DesignGate {
  id: string;
  label: string;
}

export interface DesignApproval {
  gateId: string;
  approvedAt: string;
  specHash: string;
  payload: unknown;
}

type DesignLedgerStatus = "current" | "stale" | "missing";

interface DesignLedgerEvent {
  type: "approval" | "freeze" | "edit";
  stage: string;
  gateId?: string;
  artifactHash: string;
  specHash: string;
  previousSpecHash?: string;
  timestamp: string;
  scope: DesignStorageScope;
  rootDir: string;
  storageRoot: string;
  source: "approveDesignGate" | "freezeDesignSession" | "editFrozenDesignSpec";
  status: DesignLedgerStatus;
  sessionId: string;
  stopReason?: string;
  staleGateIds?: string[];
  missingGateIds?: string[];
}

export interface DesignFreeze {
  specHash: string;
  invalidated: boolean;
  approvalHashes?: Record<string, string>;
}

export type HistoryWindow = "7d" | "30d" | "90d" | "all";
export type HistoryProjectScope = "current" | "all";
export type DesignStorageScope = "project" | "global";
export type DesignExecutionProfile = "restricted" | "normal-project" | "custom";

export interface DesignModelSelection {
  candidateModelIds: string[];
  selectedModelIds: string[];
  judgeModelIds: string[];
}

export type DesignHardBudgetCeilings = Record<string, number>;

export interface DesignHistoryFilter {
  window: HistoryWindow;
  project: HistoryProjectScope;
}

export interface DesignSpecDraft {
  schemaVersion: 1;
  mode: DesignMode;
  skillName: string;
  directPath?: string;
  generatedReferences: boolean;
  historyWindow?: DesignHistoryFilter;
  models: DesignModelSelection;
  executionProfile: DesignExecutionProfile;
  hardBudgetCeilings: DesignHardBudgetCeilings;
}

export interface DesignSession {
  schemaVersion: 1;
  id: string;
  status: DesignStatus;
  mode: DesignMode;
  skillName: string;
  directPath?: string;
  historyWindow?: DesignHistoryFilter;
  models: DesignModelSelection;
  executionProfile: DesignExecutionProfile;
  hardBudgetCeilings: DesignHardBudgetCeilings;
  usedHistoryRanking: boolean;
  generatedReferences: boolean;
  noninteractive: boolean;
  json: boolean;
  gates: DesignGate[];
  approvals: DesignApproval[];
  spec: DesignSpecDraft;
  statePath: string;
  rootDir: string;
  homeDir?: string;
  storageScope: DesignStorageScope;
  storageRoot: string;
  freeze?: DesignFreeze;
  stopReason?: string;
}

export interface StartDesignSessionOptions {
  rootDir: string;
  mode: DesignMode;
  skillName: string;
  directPath?: string;
  generatedReferences?: boolean;
  noninteractive?: boolean;
  json?: boolean;
  historyWindow?: DesignHistoryFilter;
  models?: Partial<DesignModelSelection>;
  executionProfile?: DesignExecutionProfile;
  hardBudgetCeilings?: DesignHardBudgetCeilings;
  storageScope?: DesignStorageScope;
  homeDir?: string;
}

export const DESIGN_GATES: DesignGate[] = [
  { id: "selection", label: "Skill/model selection" },
  { id: "scenarios", label: "Scenarios and fixtures" },
  { id: "action-contract", label: "Action contract" },
  { id: "references", label: "Reference package" },
  { id: "rubric", label: "Rubric and thresholds" },
  { id: "models", label: "Models and judges" },
  { id: "execution-profile", label: "Execution profile" },
  { id: "budgets", label: "Hard spend/runtime ceilings" },
];

export function designGateIds(): string[] {
  return DESIGN_GATES.map((gate) => gate.id);
}

export function freezeReviewedManifestV1(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const fingerprint =
    manifest.fingerprint && typeof manifest.fingerprint === "object" && !Array.isArray(manifest.fingerprint)
      ? (manifest.fingerprint as Record<string, unknown>)
      : {};
  return {
    ...manifest,
    status: "frozen",
    approvals: {
      frozen: true,
      budget: true,
      liveCellsAllowed: false,
    },
    fingerprint: {
      ...fingerprint,
      status: "current",
    },
  };
}

export function validateDesignApprovalLedgerV1(
  text: string,
  expectedSpecHash: string,
  options: { requireFreeze: boolean },
): { ok: true } | { ok: false; reason: string; missingGateIds?: string[] } {
  const approved = new Set<string>();
  let freezeCount = 0;
  try {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        return { ok: false, reason: "approval ledger contains a non-object event" };
      }
      const record = event as Record<string, unknown>;
      const hash =
        typeof record.specContentHash === "string"
          ? record.specContentHash
          : record.specHash;
      if (hash !== expectedSpecHash) continue;
      if (record.type === "approval") {
        if (
          record.approved !== true ||
          typeof record.gateId !== "string" ||
          !designGateIds().includes(record.gateId)
        ) {
          return { ok: false, reason: "approval ledger contains an invalid current approval" };
        }
        if (approved.has(record.gateId)) {
          return { ok: false, reason: `approval ledger duplicates current gate ${record.gateId}` };
        }
        approved.add(record.gateId);
      }
      if (
        record.type === "freeze" &&
        (record.status === "frozen" || record.status === "current")
      ) {
        freezeCount += 1;
      }
    }
  } catch {
    return { ok: false, reason: "approval ledger is invalid JSONL" };
  }
  const missingGateIds = designGateIds().filter((gate) => !approved.has(gate));
  if (missingGateIds.length > 0) {
    return {
      ok: false,
      reason: `approval ledger missing current gates ${missingGateIds.join(", ")}`,
      missingGateIds,
    };
  }
  if (options.requireFreeze && freezeCount !== 1) {
    return {
      ok: false,
      reason:
        freezeCount === 0
          ? "approval ledger missing current freeze"
          : "approval ledger duplicates current freeze",
    };
  }
  return { ok: true };
}

function normalizeModelSelection(models: Partial<DesignModelSelection> = {}): DesignModelSelection {
  const selectedModelIds = [...new Set(models.selectedModelIds ?? [])];
  const candidateModelIds = [...new Set([...(models.candidateModelIds ?? []), ...selectedModelIds])];
  const judgeModelIds = [...new Set(models.judgeModelIds ?? [])];
  return { candidateModelIds, selectedModelIds, judgeModelIds };
}

export function startDesignSession(options: StartDesignSessionOptions): DesignSession {
  const id = `design-${stableHash({ mode: options.mode, skillName: options.skillName, directPath: options.directPath, at: Date.now() }).slice(0, 12)}`;
  const historyWindow = options.mode === "guided" ? (options.historyWindow ?? ({ window: "30d", project: "all" } as const)) : undefined;
  const storageScope = options.storageScope ?? "project";
  const models = normalizeModelSelection(options.models);
  const executionProfile = options.executionProfile ?? "restricted";
  const hardBudgetCeilings = options.hardBudgetCeilings ?? {};
  const paths = resolveSkillBenchPaths({ cwd: options.rootDir, home: options.homeDir });
  const storageRoot = storageScope === "project" ? paths.projectRoot : paths.globalRoot;
  const spec: DesignSpecDraft = {
    schemaVersion: 1,
    mode: options.mode,
    skillName: options.skillName,
    directPath: options.directPath,
    generatedReferences: options.generatedReferences ?? false,
    historyWindow,
    models,
    executionProfile,
    hardBudgetCeilings,
  };
  const session: DesignSession = {
    schemaVersion: 1,
    id,
    status: "draft",
    mode: options.mode,
    skillName: options.skillName,
    directPath: options.directPath,
    historyWindow,
    models,
    executionProfile,
    hardBudgetCeilings,
    usedHistoryRanking: options.mode === "guided",
    generatedReferences: options.generatedReferences ?? false,
    noninteractive: options.noninteractive ?? false,
    json: options.json ?? false,
    gates: DESIGN_GATES,
    approvals: [],
    spec,
    statePath: path.join(storageRoot, "design", `${id}.json`),
    rootDir: options.rootDir,
    homeDir: options.homeDir,
    storageScope,
    storageRoot,
  };
  return saveDesignSession(session);
}

export function loadDesignSession(statePath: string): DesignSession {
  return JSON.parse(readFileSync(statePath, "utf8")) as DesignSession;
}

export function nextDesignGate(session: DesignSession): DesignGate | null {
  const currentHash = specContentHash(session.spec);
  const approved = new Set(session.approvals.filter((approval) => approval.specHash === currentHash).map((approval) => approval.gateId));
  return session.gates.find((gate) => !approved.has(gate.id)) ?? null;
}

export function approveDesignGate(session: DesignSession, gateId: string, payload: unknown): DesignSession {
  if (session.status === "frozen") throw new Error("frozen design is immutable");
  if (!session.gates.some((gate) => gate.id === gateId)) throw new Error(`unknown design gate: ${gateId}`);
  const currentHash = specContentHash(session.spec);
  if (session.approvals.some((approval) => approval.gateId === gateId && approval.specHash === currentHash)) throw new Error("approvals are append-only");
  const approvedAt = new Date().toISOString();
  const updated: DesignSession = {
    ...session,
    status: "draft",
    approvals: [...session.approvals, { gateId, payload, approvedAt, specHash: currentHash }],
    stopReason: undefined,
  };
  return saveDesignSessionWithLedgerEvent(updated, {
    type: "approval",
    stage: gateId,
    gateId,
    artifactHash: currentHash,
    specHash: currentHash,
    timestamp: approvedAt,
    source: "approveDesignGate",
    status: "current",
  });
}

export function freezeDesignSession(session: DesignSession, options: { saveAndStopIfMissingApprovals?: boolean } = {}): DesignSession {
  if (session.status === "frozen") {
    const currentHash = specContentHash(session.spec);
    if (canRunDesignSession(session)) {
      appendFreezeLedgerEvent(session, currentHash, "current");
      return session;
    }
    const stopReason = "stale freeze: spec hash changed";
    if (options.saveAndStopIfMissingApprovals && session.noninteractive && session.json) return stopAndSave(session, stopReason, { type: "freeze", status: "stale", specHash: currentHash });
    appendFreezeLedgerEvent(session, currentHash, "stale", { stopReason });
    throw new Error(stopReason);
  }
  const approvalState = designApprovalState(session);
  if (session.generatedReferences && !approvalState.approvedGateIds.has("references")) {
    if (approvalState.stale.includes("references")) {
      const stopReason = "stale approvals: references";
      if (options.saveAndStopIfMissingApprovals && session.noninteractive && session.json) return stopAndSave(session, stopReason, { type: "freeze", status: "stale", specHash: approvalState.specHash, staleGateIds: ["references"] });
      appendFreezeLedgerEvent(session, approvalState.specHash, "stale", { stopReason, staleGateIds: ["references"] });
      throw new Error(stopReason);
    }
    const stopReason = "missing approvals: generated references require approval";
    if (options.saveAndStopIfMissingApprovals && session.noninteractive && session.json) return stopAndSave(session, stopReason, { type: "freeze", status: "missing", specHash: approvalState.specHash, missingGateIds: ["references"] });
    appendFreezeLedgerEvent(session, approvalState.specHash, "missing", { stopReason, missingGateIds: ["references"] });
    throw new Error("generated references require approval");
  }
  if (approvalState.stale.length > 0) {
    const stopReason = `stale approvals: ${approvalState.stale.join(",")}`;
    if (options.saveAndStopIfMissingApprovals && session.noninteractive && session.json) return stopAndSave(session, stopReason, { type: "freeze", status: "stale", specHash: approvalState.specHash, staleGateIds: approvalState.stale });
    appendFreezeLedgerEvent(session, approvalState.specHash, "stale", { stopReason, staleGateIds: approvalState.stale });
    throw new Error(stopReason);
  }
  if (approvalState.missing.length > 0) {
    const stopReason = `missing approvals: ${approvalState.missing.join(",")}`;
    if (options.saveAndStopIfMissingApprovals && session.noninteractive && session.json) return stopAndSave(session, stopReason, { type: "freeze", status: "missing", specHash: approvalState.specHash, missingGateIds: approvalState.missing });
    appendFreezeLedgerEvent(session, approvalState.specHash, "missing", { stopReason, missingGateIds: approvalState.missing });
    throw new Error(stopReason);
  }
  const frozen: DesignSession = {
    ...session,
    status: "frozen",
    freeze: { specHash: approvalState.specHash, invalidated: false, approvalHashes: approvalState.approvalHashes },
    stopReason: undefined,
  };
  return saveDesignSessionWithLedgerEvent(
    frozen,
    freezeLedgerEvent(approvalState.specHash, "current"),
  );
}

export function canRunDesignSession(session: DesignSession): boolean {
  return session.status === "frozen" && session.freeze?.invalidated === false && session.freeze.specHash === specContentHash(session.spec);
}

export function editFrozenDesignSpec(session: DesignSession, edit: (spec: DesignSpecDraft) => DesignSpecDraft): DesignSession {
  const beforeHash = specContentHash(session.spec);
  const editedSpec = edit(session.spec);
  const afterHash = specContentHash(editedSpec);
  const approvals = session.approvals;
  if (session.status !== "frozen") {
    const edited = {
      ...session,
      skillName: editedSpec.skillName,
      directPath: editedSpec.directPath,
      generatedReferences: editedSpec.generatedReferences,
      historyWindow: editedSpec.historyWindow,
      models: editedSpec.models,
      executionProfile: editedSpec.executionProfile,
      hardBudgetCeilings: editedSpec.hardBudgetCeilings,
      spec: editedSpec,
      approvals,
    };
    return saveDesignSessionWithLedgerEvent(
      edited,
      editLedgerEvent(edited, beforeHash, afterHash),
    );
  }
  const edited: DesignSession = {
    ...session,
    status: "draft",
    skillName: editedSpec.skillName,
    directPath: editedSpec.directPath,
    generatedReferences: editedSpec.generatedReferences,
    historyWindow: editedSpec.historyWindow,
    models: editedSpec.models,
    executionProfile: editedSpec.executionProfile,
    hardBudgetCeilings: editedSpec.hardBudgetCeilings,
    approvals,
    spec: editedSpec,
    freeze: { ...session.freeze, specHash: session.freeze?.specHash ?? beforeHash, invalidated: beforeHash !== afterHash || session.freeze?.invalidated === true },
  };
  return saveDesignSessionWithLedgerEvent(
    edited,
    editLedgerEvent(edited, beforeHash, afterHash),
  );
}

function designApprovalState(session: DesignSession): {
  specHash: string;
  approvedGateIds: Set<string>;
  approvalHashes: Record<string, string>;
  missing: string[];
  stale: string[];
} {
  const specHash = specContentHash(session.spec);
  const approvedGateIds = new Set<string>();
  const approvalHashes: Record<string, string> = {};
  const missing: string[] = [];
  const stale: string[] = [];
  for (const gate of session.gates) {
    const gateApprovals = session.approvals.filter((approval) => approval.gateId === gate.id);
    if (gateApprovals.length === 0) {
      missing.push(gate.id);
      continue;
    }
    const currentApproval = gateApprovals.find((approval) => approval.specHash === specHash);
    if (!currentApproval) {
      stale.push(gate.id);
      continue;
    }
    approvedGateIds.add(gate.id);
    approvalHashes[gate.id] = currentApproval.specHash;
  }
  return { specHash, approvedGateIds, approvalHashes, missing, stale };
}

function stopAndSave(
  session: DesignSession,
  stopReason: string,
  ledger?: { type: "freeze"; status: DesignLedgerStatus; specHash: string; staleGateIds?: string[]; missingGateIds?: string[] },
): DesignSession {
  const stopped = { ...session, status: "stopped" as const, stopReason };
  if (!ledger) return saveDesignSession(stopped);
  return saveDesignSessionWithLedgerEvent(
    stopped,
    freezeLedgerEvent(ledger.specHash, ledger.status, {
      stopReason,
      staleGateIds: ledger.staleGateIds,
      missingGateIds: ledger.missingGateIds,
    }),
  );
}

function freezeLedgerEvent(
  specHash: string,
  status: DesignLedgerStatus,
  details: { stopReason?: string; staleGateIds?: string[]; missingGateIds?: string[] } = {},
): Omit<DesignLedgerEvent, "scope" | "rootDir" | "storageRoot" | "sessionId"> {
  return {
    type: "freeze",
    stage: "freeze",
    artifactHash: specHash,
    specHash,
    timestamp: new Date().toISOString(),
    source: "freezeDesignSession",
    status,
    stopReason: details.stopReason,
    staleGateIds: details.staleGateIds,
    missingGateIds: details.missingGateIds,
  };
}

function appendFreezeLedgerEvent(
  session: DesignSession,
  specHash: string,
  status: DesignLedgerStatus,
  details: { stopReason?: string; staleGateIds?: string[]; missingGateIds?: string[] } = {},
): void {
  appendDesignLedgerEvent(session, freezeLedgerEvent(specHash, status, details));
}

function editLedgerEvent(
  session: DesignSession,
  beforeHash: string,
  afterHash: string,
): Omit<DesignLedgerEvent, "scope" | "rootDir" | "storageRoot" | "sessionId"> {
  const staleGateIds = beforeHash === afterHash ? [] : session.approvals.filter((approval) => approval.specHash === beforeHash).map((approval) => approval.gateId);
  return {
    type: "edit",
    stage: "edit",
    artifactHash: afterHash,
    specHash: afterHash,
    previousSpecHash: beforeHash,
    timestamp: new Date().toISOString(),
    source: "editFrozenDesignSpec",
    status: beforeHash === afterHash ? "current" : "stale",
    staleGateIds,
  };
}

function openDesignLedger(session: DesignSession): { fd: number; size: number } {
  const ledgerPath = path.join(path.dirname(session.statePath), "approvals.jsonl");
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const opened = openRegularFile(
    ledgerPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    {
      rejectHardlinks: true,
      trustedRoot: path.dirname(path.dirname(session.storageRoot)),
    },
  );
  if (opened.ok) return { fd: opened.fd, size: Number(opened.stat.size) };
  if (opened.reason === "unavailable") {
    throw new Error("approval ledger could not be opened safely");
  }
  throw new Error("approval ledger must be a regular file and remain stable");
}

function writeDesignLedgerEvent(
  fd: number,
  session: DesignSession,
  event: Omit<DesignLedgerEvent, "scope" | "rootDir" | "storageRoot" | "sessionId">,
): void {
  const normalized: DesignLedgerEvent = {
    ...event,
    scope: session.storageScope,
    rootDir: session.rootDir,
    storageRoot: session.storageRoot,
    sessionId: session.id,
  };
  writeAllSync(fd, `${JSON.stringify(normalized)}\n`);
  fsyncSync(fd);
}

function appendDesignLedgerEvent(
  session: DesignSession,
  event: Omit<DesignLedgerEvent, "scope" | "rootDir" | "storageRoot" | "sessionId">,
): void {
  const { fd } = openDesignLedger(session);
  try {
    writeDesignLedgerEvent(fd, session, event);
  } finally {
    closeSync(fd);
  }
}

function saveDesignSessionWithLedgerEvent(
  session: DesignSession,
  event: Omit<DesignLedgerEvent, "scope" | "rootDir" | "storageRoot" | "sessionId">,
): DesignSession {
  const { fd, size } = openDesignLedger(session);
  try {
    writeDesignLedgerEvent(fd, session, event);
    try {
      return saveDesignSession(session);
    } catch (error) {
      try {
        ftruncateSync(fd, size);
        fsyncSync(fd);
      } catch {
        throw new Error(
          "design state save failed and approval ledger rollback failed",
          { cause: error },
        );
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

function saveDesignSession(session: DesignSession): DesignSession {
  mkdirSync(path.dirname(session.statePath), { recursive: true });
  const paths: SkillBenchPaths = resolveSkillBenchPaths({ cwd: session.rootDir, home: session.homeDir });
  const scope: SkillBenchScope = session.storageScope === "global" ? "global" : "project";
  const root = scope === "project" ? paths.projectRoot : paths.globalRoot;
  const relative = path.relative(root, session.statePath).split(path.sep).join("/");
  writeSkillBenchJsonAtomic(paths, scope, relative, session);
  return loadDesignSession(session.statePath);
}
