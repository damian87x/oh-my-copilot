import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ompRoot } from "../omp-root.js";
import {
  atomicWrite,
  ensureDir,
  openRegularFile,
} from "../utils/fs.js";

const MAX_STORIES = 100;
const MAX_CRITERIA_PER_STORY = 50;
const MAX_EVIDENCE_RECORDS = 1_000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORY_ID_PATTERN = /^G\d{3}$/;
const CRITERION_ID_PATTERN = /^C\d{3}$/;
const EVIDENCE_ID_PATTERN = /^E\d{4}$/;

export type UltragoalStatus = "active" | "awaiting_gate" | "complete";
export type StoryStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "failed"
  | "superseded";

export interface UltragoalCriterion {
  id: string;
  text: string;
  evidence: UltragoalEvidence[];
}

export interface UltragoalEvidence {
  id: string;
  criterionId: string;
  kind: "file" | "note";
  summary: string;
  path?: string;
  sha256: string;
  planRevision: number;
  recordedAt: string;
}

export interface UltragoalStory {
  id: string;
  title: string;
  objective: string;
  status: StoryStatus;
  attempts: number;
  criteria: UltragoalCriterion[];
  startedAt?: string;
  completedAt?: string;
  supersededBy?: string[];
  resolver?: {
    role: "verifier" | "code-reviewer" | "architect";
    gateRevision: number;
  };
}

export interface UltragoalGateSummary {
  status: "passed" | "blocked";
  planRevision: number;
  artifactPath: string;
  recordedAt: string;
}

interface UltragoalOperation {
  fingerprint: string;
  revision: number;
}

export interface UltragoalManifest {
  schemaVersion: 1;
  planId: string;
  sessionId: string;
  sessionKey: string;
  goalGeneration?: string;
  objective: string;
  status: UltragoalStatus;
  revision: number;
  activeStoryId: string | null;
  source: {
    kind: "objective" | "ralplan";
    sha256: string;
    snapshotPath: string;
    originalPath?: string;
  };
  stories: UltragoalStory[];
  lastGate?: UltragoalGateSummary;
  operations: Record<string, UltragoalOperation>;
  lastLedgerHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryInput {
  title: string;
  objective: string;
  criteria?: string[];
}

export interface CreateUltragoalInput {
  cwd: string;
  sessionId: string;
  operationId: string;
  objective: string;
  goalGeneration?: string;
  stories?: StoryInput[];
  planFile?: string;
}

export interface UltragoalMutationInput {
  cwd: string;
  sessionId: string;
  operationId: string;
}

export interface AttachEvidenceInput extends UltragoalMutationInput {
  storyId: string;
  criterionId: string;
  summary: string;
  file?: string;
}

export type SteeringKind =
  | "add"
  | "split"
  | "reorder"
  | "revise"
  | "annotate"
  | "supersede";

export interface SteerUltragoalInput extends UltragoalMutationInput {
  kind: SteeringKind;
  evidence: string;
  rationale: string;
  targetStoryId?: string;
  stories?: StoryInput[];
  pendingOrder?: string[];
  title?: string;
  objective?: string;
  criteria?: string[];
}

export interface UltragoalPaths {
  root: string;
  directory: string;
  sessionKey: string;
  manifest: string;
  brief: string;
  ledger: string;
  lock: string;
  pending: string;
  evidenceDirectory: string;
  gateDirectory: string;
}

export interface GateRoleResult {
  role: "verifier" | "code-reviewer" | "architect";
  verdict: "PASS" | "BLOCK" | "INCONCLUSIVE";
  planRevision: number;
  summary: string;
  outputPath: string;
  outputSha256: string;
  exitCode: number;
  timedOut: boolean;
  overflowed: boolean;
}

export interface UltragoalGateResult {
  schemaVersion: 1;
  status: "passed" | "blocked";
  planRevision: number;
  roles: GateRoleResult[];
  createdAt: string;
  artifactPath: string;
}

interface LedgerEntry {
  schemaVersion: 1;
  sessionId: string;
  planId: string;
  revision: number;
  operationId: string;
  operationFingerprint: string;
  event: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  previousHash: string | null;
  stateHash: string;
  entryHash: string;
}

interface PendingMutation {
  schemaVersion: 1;
  manifest: UltragoalManifest;
  ledgerEntry: LedgerEntry;
}

export class UltragoalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "UltragoalError";
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UltragoalError("INVALID_NUMBER", "numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new UltragoalError("INVALID_JSON", `unsupported value type ${typeof value}`);
}

function requireText(value: unknown, code: string, name: string, max = 4_000): string {
  const text = String(value ?? "").trim();
  if (!text) throw new UltragoalError(code, `${name} is required`);
  if (text.length > max) throw new UltragoalError(code, `${name} exceeds ${max} characters`);
  return text;
}

function sessionKey(sessionId: string): string {
  return sha256(sessionId);
}

export function ultragoalPaths(cwd: string, rawSessionId: string): UltragoalPaths {
  const root = ompRoot(cwd);
  const key = sessionKey(rawSessionId);
  const directory = join(root, ".omp", "ultragoal", key);
  return {
    root,
    directory,
    sessionKey: key,
    manifest: join(directory, "manifest.json"),
    brief: join(directory, "brief.md"),
    ledger: join(directory, "ledger.jsonl"),
    lock: join(directory, "aggregate.lock"),
    pending: join(directory, "pending.json"),
    evidenceDirectory: join(directory, "evidence"),
    gateDirectory: join(directory, "gates"),
  };
}

interface AggregateLock {
  descriptor: number;
  token: string;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface StaleLockObservation {
  dev: number;
  ino: number;
  content: string;
}

function staleLock(path: string): StaleLockObservation | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    const content = readFileSync(path, "utf8");
    let stale = false;
    try {
      const parsed = JSON.parse(content) as {
        pid?: number;
        acquiredAt?: string;
      };
      const age = Date.now() - Date.parse(String(parsed.acquiredAt ?? ""));
      stale =
        !pidAlive(Number(parsed.pid))
        || (Number.isFinite(age) && age > LOCK_STALE_AFTER_MS);
    } catch {
      stale = Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS;
    }
    return stale ? { dev: stat.dev, ino: stat.ino, content } : undefined;
  } catch {
    return undefined;
  }
}

function recoveryClaimPrefix(path: string): string {
  return `${basename(path)}.recovery-`;
}

function hasActiveRecoveryClaim(path: string): boolean {
  const directory = dirname(path);
  const prefix = recoveryClaimPrefix(path);
  try {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const recoveryPid = Number(name.slice(prefix.length).split("-", 1)[0]);
      if (pidAlive(recoveryPid)) return true;
      try {
        rmSync(join(directory, name), { force: true });
      } catch {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function claimObservedStaleLock(
  path: string,
  observed: StaleLockObservation,
): boolean {
  const claim = `${path}.recovery-${process.pid}-${randomUUID()}`;
  try {
    linkSync(path, claim);
  } catch {
    return false;
  }
  try {
    const claimed = lstatSync(claim);
    if (
      !claimed.isFile()
      || claimed.dev !== observed.dev
      || claimed.ino !== observed.ino
      || readFileSync(claim, "utf8") !== observed.content
    ) {
      return false;
    }
    try {
      const current = lstatSync(path);
      if (
        current.isFile()
        && current.dev === claimed.dev
        && current.ino === claimed.ino
        && readFileSync(path, "utf8") === observed.content
      ) {
        rmSync(path, { force: true });
      }
    } catch {
      // Another recovery or the original owner already removed the stale path.
    }
    return true;
  } finally {
    rmSync(claim, { force: true });
  }
}

function ownsCanonicalLock(path: string, descriptor: number, token: string): boolean {
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    const metadata = JSON.parse(readFileSync(path, "utf8")) as {
      token?: string;
    };
    return (
      current.isFile()
      && current.dev === opened.dev
      && current.ino === opened.ino
      && metadata.token === token
    );
  } catch {
    return false;
  }
}

function removeOwnedCanonicalLock(path: string, token: string): void {
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as {
      token?: string;
    };
    if (current.token === token) rmSync(path, { force: true });
  } catch {
    // Missing or replaced locks are not owned by this caller.
  }
}

function acquireLock(paths: UltragoalPaths): AggregateLock {
  mkdirSync(paths.directory, { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (hasActiveRecoveryClaim(paths.lock)) {
      throw new UltragoalError("ULTRAGOAL_BUSY", "lock recovery is in progress");
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(paths.lock, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${canonicalJson({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token,
        })}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      if (hasActiveRecoveryClaim(paths.lock)) {
        removeOwnedCanonicalLock(paths.lock, token);
        throw new UltragoalError("ULTRAGOAL_BUSY", "lock recovery is in progress");
      }
      if (!ownsCanonicalLock(paths.lock, descriptor, token)) {
        throw new UltragoalError(
          "ULTRAGOAL_BUSY",
          "lock ownership changed during recovery",
        );
      }
      return { descriptor, token };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (
        error
        && typeof error === "object"
        && "code" in error
        && error.code === "EEXIST"
        && attempt === 0
      ) {
        const observed = staleLock(paths.lock);
        if (observed && claimObservedStaleLock(paths.lock, observed)) continue;
      }
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new UltragoalError("ULTRAGOAL_BUSY", "another mutation owns this plan");
      }
      throw error;
    }
  }
  throw new UltragoalError("ULTRAGOAL_BUSY", "another mutation owns this plan");
}

function withLock<T>(paths: UltragoalPaths, callback: () => T): T {
  const lock = acquireLock(paths);
  try {
    return callback();
  } finally {
    closeSync(lock.descriptor);
    removeOwnedCanonicalLock(paths.lock, lock.token);
  }
}

function writeJson(path: string, value: unknown): void {
  ensureDir(path);
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function manifestCorrupt(message: string): never {
  throw new UltragoalError("MANIFEST_CORRUPT", message);
}

function safeProjectRelative(root: string, value: unknown): value is string {
  if (typeof value !== "string" || !value || isAbsolute(value)) return false;
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateManifest(
  paths: UltragoalPaths,
  parsed: unknown,
  verifySource = true,
): UltragoalManifest {
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    return manifestCorrupt(`invalid manifest ${paths.manifest}`);
  }
  const manifest = parsed as unknown as UltragoalManifest;
  if (
    typeof manifest.planId !== "string"
    || !/^[a-f0-9-]{36}$/i.test(manifest.planId)
    || typeof manifest.sessionId !== "string"
    || !manifest.sessionId
    || manifest.sessionId.length > 500
    || manifest.sessionKey !== paths.sessionKey
    || sessionKey(manifest.sessionId) !== manifest.sessionKey
    || (
      manifest.goalGeneration !== undefined
      && !SHA256_PATTERN.test(manifest.goalGeneration)
    )
    || typeof manifest.objective !== "string"
    || !manifest.objective.trim()
    || manifest.objective.length > 4_000
    || !["active", "awaiting_gate", "complete"].includes(manifest.status)
    || !Number.isInteger(manifest.revision)
    || manifest.revision < 1
    || !validTimestamp(manifest.createdAt)
    || !validTimestamp(manifest.updatedAt)
  ) {
    return manifestCorrupt("invalid manifest identity, status, revision, or timestamps");
  }
  if (!isRecord(manifest.source)) {
    return manifestCorrupt("invalid source snapshot");
  }
  const expectedSnapshotPath = relative(paths.root, paths.brief);
  if (
    !["objective", "ralplan"].includes(manifest.source.kind)
    || !SHA256_PATTERN.test(manifest.source.sha256)
    || manifest.source.snapshotPath !== expectedSnapshotPath
    || (
      manifest.source.originalPath !== undefined
      && !safeProjectRelative(paths.root, manifest.source.originalPath)
    )
  ) {
    return manifestCorrupt("invalid source snapshot metadata");
  }
  if (!Array.isArray(manifest.stories) || manifest.stories.length < 1 || manifest.stories.length > MAX_STORIES) {
    return manifestCorrupt(`stories must contain 1-${MAX_STORIES} records`);
  }

  const storyIds = new Set<string>();
  const evidenceIds = new Set<string>();
  let inProgressStory: string | null = null;
  let criterionCount = 0;
  for (const story of manifest.stories) {
    if (
      !isRecord(story)
      || typeof story.id !== "string"
      || !STORY_ID_PATTERN.test(story.id)
      || storyIds.has(story.id)
      || typeof story.title !== "string"
      || !story.title.trim()
      || story.title.length > 200
      || typeof story.objective !== "string"
      || !story.objective.trim()
      || story.objective.length > 4_000
      || !["pending", "in_progress", "complete", "failed", "superseded"].includes(story.status)
      || !Number.isInteger(story.attempts)
      || story.attempts < 0
      || !Array.isArray(story.criteria)
      || story.criteria.length < 1
      || story.criteria.length > MAX_CRITERIA_PER_STORY
    ) {
      return manifestCorrupt("invalid story record");
    }
    storyIds.add(story.id);
    if (story.status === "in_progress") {
      if (inProgressStory) return manifestCorrupt("multiple stories are in progress");
      inProgressStory = story.id;
    }
    if (story.startedAt !== undefined && !validTimestamp(story.startedAt)) {
      return manifestCorrupt(`invalid startedAt for ${story.id}`);
    }
    if (story.completedAt !== undefined && !validTimestamp(story.completedAt)) {
      return manifestCorrupt(`invalid completedAt for ${story.id}`);
    }
    if (
      story.supersededBy !== undefined
      && (
        !Array.isArray(story.supersededBy)
        || story.supersededBy.some((id) => typeof id !== "string" || !STORY_ID_PATTERN.test(id))
      )
    ) {
      return manifestCorrupt(`invalid supersededBy for ${story.id}`);
    }
    if (
      story.resolver !== undefined
      && (
        !isRecord(story.resolver)
        || !["verifier", "code-reviewer", "architect"].includes(story.resolver.role)
        || !Number.isInteger(story.resolver.gateRevision)
        || story.resolver.gateRevision < 1
      )
    ) {
      return manifestCorrupt(`invalid resolver for ${story.id}`);
    }

    const criterionIds = new Set<string>();
    for (const criterion of story.criteria) {
      criterionCount += 1;
      if (criterionCount > MAX_EVIDENCE_RECORDS) {
        return manifestCorrupt(`criteria exceed ${MAX_EVIDENCE_RECORDS} records`);
      }
      if (
        !isRecord(criterion)
        || typeof criterion.id !== "string"
        || !CRITERION_ID_PATTERN.test(criterion.id)
        || criterionIds.has(criterion.id)
        || typeof criterion.text !== "string"
        || !criterion.text.trim()
        || criterion.text.length > 500
        || !Array.isArray(criterion.evidence)
      ) {
        return manifestCorrupt(`invalid criterion for ${story.id}`);
      }
      criterionIds.add(criterion.id);
      for (const evidence of criterion.evidence) {
        if (
          !isRecord(evidence)
          || typeof evidence.id !== "string"
          || !EVIDENCE_ID_PATTERN.test(evidence.id)
          || evidenceIds.has(evidence.id)
          || evidence.criterionId !== criterion.id
          || !["file", "note"].includes(evidence.kind)
          || typeof evidence.summary !== "string"
          || !evidence.summary.trim()
          || evidence.summary.length > 2_000
          || !SHA256_PATTERN.test(evidence.sha256)
          || !Number.isInteger(evidence.planRevision)
          || evidence.planRevision < 1
          || evidence.planRevision > manifest.revision
          || !validTimestamp(evidence.recordedAt)
          || (
            evidence.kind === "file"
            && !safeProjectRelative(paths.root, evidence.path)
          )
          || (evidence.kind === "note" && evidence.path !== undefined)
        ) {
          return manifestCorrupt(`invalid evidence for ${story.id}/${criterion.id}`);
        }
        evidenceIds.add(evidence.id);
        if (evidenceIds.size > MAX_EVIDENCE_RECORDS) {
          return manifestCorrupt(`evidence exceeds ${MAX_EVIDENCE_RECORDS} records`);
        }
      }
    }
  }
  for (const story of manifest.stories) {
    if (story.supersededBy?.some((id) => !storyIds.has(id))) {
      return manifestCorrupt(`unknown supersededBy story for ${story.id}`);
    }
  }
  if (
    (manifest.activeStoryId !== null && !storyIds.has(manifest.activeStoryId))
    || manifest.activeStoryId !== inProgressStory
  ) {
    return manifestCorrupt("activeStoryId does not match the in-progress story");
  }
  const allTerminal = manifest.stories.every(
    (story) => story.status === "complete" || story.status === "superseded",
  );
  if (
    (manifest.status === "active" && allTerminal)
    || (manifest.status === "awaiting_gate" && !allTerminal)
    || (manifest.status === "complete" && (!allTerminal || manifest.lastGate?.status !== "passed"))
  ) {
    return manifestCorrupt("manifest status does not match story or gate state");
  }
  if (manifest.lastGate !== undefined) {
    if (
      !isRecord(manifest.lastGate)
      || !["passed", "blocked"].includes(manifest.lastGate.status)
      || !Number.isInteger(manifest.lastGate.planRevision)
      || manifest.lastGate.planRevision < 1
      || !safeProjectRelative(paths.root, manifest.lastGate.artifactPath)
      || !validTimestamp(manifest.lastGate.recordedAt)
    ) {
      return manifestCorrupt("invalid lastGate");
    }
    const gatePath = resolve(paths.root, manifest.lastGate.artifactPath);
    const gateRel = relative(paths.gateDirectory, gatePath);
    if (gateRel === ".." || gateRel.startsWith(`..${sep}`) || isAbsolute(gateRel)) {
      return manifestCorrupt("lastGate artifact is outside the gate directory");
    }
  }
  if (!isRecord(manifest.operations) || Object.keys(manifest.operations).length !== manifest.revision) {
    return manifestCorrupt("operation records do not match the manifest revision");
  }
  for (const [operationId, operation] of Object.entries(manifest.operations)) {
    if (
      !operationId
      || operationId.length > 500
      || !isRecord(operation)
      || !SHA256_PATTERN.test(operation.fingerprint)
      || !Number.isInteger(operation.revision)
      || operation.revision < 1
      || operation.revision > manifest.revision
    ) {
      return manifestCorrupt("invalid operation record");
    }
  }
  if (
    manifest.lastLedgerHash !== null
    && !SHA256_PATTERN.test(manifest.lastLedgerHash)
  ) {
    return manifestCorrupt("invalid lastLedgerHash");
  }

  if (verifySource) {
    const opened = openRegularFile(paths.brief, constants.O_RDONLY, {
      trustedRoot: paths.root,
      rejectHardlinks: true,
    });
    if (!opened.ok) {
      throw new UltragoalError(
        "SOURCE_SNAPSHOT_MISMATCH",
        `cannot safely read source snapshot: ${opened.reason}`,
      );
    }
    try {
      if (fstatSync(opened.fd).size > MAX_SOURCE_BYTES) {
        throw new UltragoalError("SOURCE_SNAPSHOT_MISMATCH", "source snapshot exceeds its size bound");
      }
      if (sha256(readFileSync(opened.fd)) !== manifest.source.sha256) {
        throw new UltragoalError("SOURCE_SNAPSHOT_MISMATCH", "source snapshot hash changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  }
  return manifest;
}

function parseManifest(paths: UltragoalPaths): UltragoalManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.manifest, "utf8"));
  } catch {
    throw new UltragoalError("MANIFEST_CORRUPT", `cannot read ${paths.manifest}`);
  }
  return validateManifest(paths, parsed);
}

function validateLedgerEntry(
  raw: unknown,
  previousHash: string | null,
  revision: number,
): LedgerEntry {
  if (!isRecord(raw)) {
    throw new UltragoalError("LEDGER_CORRUPT", "ledger entry must be an object");
  }
  const entry = raw as unknown as LedgerEntry;
  if (
    entry.schemaVersion !== 1
    || !Number.isInteger(entry.revision)
    || entry.revision !== revision
    || entry.previousHash !== previousHash
    || typeof entry.sessionId !== "string"
    || typeof entry.planId !== "string"
    || typeof entry.operationId !== "string"
    || !entry.operationId
    || entry.operationId.length > 500
    || !SHA256_PATTERN.test(entry.operationFingerprint)
    || typeof entry.event !== "string"
    || !entry.event
    || !isRecord(entry.payload)
    || !validTimestamp(entry.occurredAt)
    || !SHA256_PATTERN.test(entry.stateHash)
    || !SHA256_PATTERN.test(entry.entryHash)
  ) {
    throw new UltragoalError("LEDGER_CORRUPT", `invalid ledger entry at revision ${revision}`);
  }
  const { entryHash, ...base } = entry;
  if (sha256(canonicalJson(base)) !== entryHash) {
    throw new UltragoalError("LEDGER_CORRUPT", `invalid ledger hash at revision ${revision}`);
  }
  return entry;
}

function appendLedgerRecord(path: string, record: string): void {
  ensureDir(path);
  const descriptor = openSync(path, "a", 0o600);
  try {
    appendFileSync(descriptor, record, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readLedgerEntries(paths: UltragoalPaths): LedgerEntry[] {
  if (!existsSync(paths.ledger)) return [];
  const buffer = readFileSync(paths.ledger);
  if (buffer.length > MAX_LEDGER_BYTES) {
    throw new UltragoalError("LEDGER_CORRUPT", "ledger exceeds its size bound");
  }
  let text = buffer.toString("utf8");
  if (text && !text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    const tail = text.slice(lastNewline + 1);
    try {
      const parsed = JSON.parse(tail);
      if (canonicalJson(parsed) !== tail) throw new Error("non-canonical");
      appendLedgerRecord(paths.ledger, "\n");
      text += "\n";
    } catch {
      const completeLength = lastNewline + 1;
      truncateSync(paths.ledger, completeLength);
      text = text.slice(0, completeLength);
    }
  }
  const entries: LedgerEntry[] = [];
  let previousHash: string | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new UltragoalError("LEDGER_CORRUPT", "ledger contains invalid JSON");
    }
    if (canonicalJson(parsed) !== line) {
      throw new UltragoalError("LEDGER_CORRUPT", "ledger record is not canonical JSON");
    }
    const entry = validateLedgerEntry(parsed, previousHash, entries.length + 1);
    entries.push(entry);
    previousHash = entry.entryHash;
  }
  return entries;
}

function validateLedgerAgainstManifest(
  paths: UltragoalPaths,
  manifest: UltragoalManifest,
): void {
  const entries = readLedgerEntries(paths);
  if (
    entries.length !== manifest.revision
    || entries.at(-1)?.entryHash !== manifest.lastLedgerHash
  ) {
    throw new UltragoalError("LEDGER_CORRUPT", "ledger revision does not match the manifest");
  }
  const operationIds = new Set<string>();
  for (const entry of entries) {
    if (
      entry.sessionId !== manifest.sessionId
      || entry.planId !== manifest.planId
      || operationIds.has(entry.operationId)
    ) {
      throw new UltragoalError("LEDGER_CORRUPT", "ledger identity or operation sequence is invalid");
    }
    operationIds.add(entry.operationId);
    const operation = Object.prototype.hasOwnProperty.call(
      manifest.operations,
      entry.operationId,
    )
      ? manifest.operations[entry.operationId]
      : undefined;
    if (
      !operation
      || operation.revision !== entry.revision
      || operation.fingerprint !== entry.operationFingerprint
    ) {
      throw new UltragoalError("LEDGER_CORRUPT", "ledger operation does not match the manifest");
    }
  }
  const last = entries.at(-1);
  if (last) {
    const stateBoundByLastEntry = structuredClone(manifest);
    stateBoundByLastEntry.lastLedgerHash = last.previousHash;
    if (sha256(canonicalJson(stateBoundByLastEntry)) !== last.stateHash) {
      throw new UltragoalError("LEDGER_CORRUPT", "manifest state hash does not match the ledger");
    }
  }
}

function recoverPending(paths: UltragoalPaths): void {
  if (!existsSync(paths.pending)) return;
  let pending: PendingMutation;
  try {
    pending = JSON.parse(readFileSync(paths.pending, "utf8")) as PendingMutation;
  } catch {
    throw new UltragoalError("PENDING_CORRUPT", "pending mutation is unreadable");
  }
  if (pending?.schemaVersion !== 1) {
    throw new UltragoalError("PENDING_CORRUPT", "pending mutation has an invalid shape");
  }
  let manifest: UltragoalManifest;
  try {
    manifest = validateManifest(paths, pending.manifest);
  } catch (error) {
    throw new UltragoalError(
      "PENDING_CORRUPT",
      error instanceof Error ? error.message : String(error),
    );
  }
  const durable = readLedgerEntries(paths);
  const alreadyRecorded = durable.at(-1)?.entryHash === pending.ledgerEntry?.entryHash;
  const expectedPrevious = alreadyRecorded
    ? durable.at(-2)?.entryHash ?? null
    : durable.at(-1)?.entryHash ?? null;
  const expectedRevision = alreadyRecorded ? durable.length : durable.length + 1;
  let entry: LedgerEntry;
  try {
    entry = validateLedgerEntry(
      pending.ledgerEntry,
      expectedPrevious,
      expectedRevision,
    );
  } catch (error) {
    throw new UltragoalError(
      "PENDING_CORRUPT",
      error instanceof Error ? error.message : String(error),
    );
  }
  const stateBoundByEntry = structuredClone(manifest);
  stateBoundByEntry.lastLedgerHash = entry.previousHash;
  if (
    manifest.revision !== entry.revision
    || manifest.lastLedgerHash !== entry.entryHash
    || sha256(canonicalJson(stateBoundByEntry)) !== entry.stateHash
  ) {
    throw new UltragoalError("PENDING_CORRUPT", "pending manifest does not match its ledger entry");
  }
  if (!alreadyRecorded) {
    appendLedgerRecord(paths.ledger, `${canonicalJson(pending.ledgerEntry)}\n`);
  }
  writeJson(paths.manifest, manifest);
  rmSync(paths.pending, { force: true });
}

function readUnlocked(paths: UltragoalPaths): UltragoalManifest {
  recoverPending(paths);
  if (!existsSync(paths.manifest)) {
    throw new UltragoalError("ULTRAGOAL_NOT_FOUND", "no plan exists for this session");
  }
  const manifest = parseManifest(paths);
  validateLedgerAgainstManifest(paths, manifest);
  return manifest;
}

export function readUltragoal(cwd: string, rawSessionId: string): UltragoalManifest {
  const sessionId = requireText(rawSessionId, "SESSION_ID_REQUIRED", "sessionId");
  const paths = ultragoalPaths(cwd, sessionId);
  return withLock(paths, () => readUnlocked(paths));
}

function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

function checkOperation(
  manifest: UltragoalManifest,
  operationId: string,
  operationFingerprint: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(manifest.operations, operationId)) {
    return false;
  }
  const prior = manifest.operations[operationId];
  if (!prior) {
    throw new UltragoalError("MANIFEST_CORRUPT", "operation record is invalid");
  }
  if (prior.fingerprint !== operationFingerprint) {
    throw new UltragoalError(
      "OPERATION_COLLISION",
      "operationId was already used with different input",
    );
  }
  return true;
}

function createLedgerEntry(
  manifest: UltragoalManifest,
  operationId: string,
  operationFingerprint: string,
  event: string,
  payload: Record<string, unknown>,
): LedgerEntry {
  // The caller has already applied the domain mutation and revision update.
  // lastLedgerHash still points to the previous entry here, so stateHash binds
  // the post-mutation state immediately before the current entry link is set.
  const base = {
    schemaVersion: 1 as const,
    sessionId: manifest.sessionId,
    planId: manifest.planId,
    revision: manifest.revision,
    operationId,
    operationFingerprint,
    event,
    payload,
    occurredAt: manifest.updatedAt,
    previousHash: manifest.lastLedgerHash,
    stateHash: sha256(canonicalJson(manifest)),
  };
  return { ...base, entryHash: sha256(canonicalJson(base)) };
}

function commitMutation(
  paths: UltragoalPaths,
  manifest: UltragoalManifest,
  operationId: string,
  operationFingerprint: string,
  event: string,
  payload: Record<string, unknown>,
): UltragoalManifest {
  manifest.revision += 1;
  manifest.updatedAt = new Date().toISOString();
  Object.defineProperty(manifest.operations, operationId, {
    value: {
      fingerprint: operationFingerprint,
      revision: manifest.revision,
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const ledgerEntry = createLedgerEntry(
    manifest,
    operationId,
    operationFingerprint,
    event,
    payload,
  );
  manifest.lastLedgerHash = ledgerEntry.entryHash;
  const pending: PendingMutation = {
    schemaVersion: 1,
    manifest,
    ledgerEntry,
  };
  writeJson(paths.pending, pending);
  appendLedgerRecord(paths.ledger, `${canonicalJson(ledgerEntry)}\n`);
  writeJson(paths.manifest, manifest);
  rmSync(paths.pending, { force: true });
  return manifest;
}

function storyFromInput(input: StoryInput, index: number): UltragoalStory {
  const title = requireText(input.title, "STORY_TITLE_REQUIRED", "story title", 200);
  const objective = requireText(input.objective, "STORY_OBJECTIVE_REQUIRED", "story objective");
  const rawCriteria = input.criteria?.length
    ? input.criteria
    : [`Complete and verify: ${objective}`];
  if (rawCriteria.length > MAX_CRITERIA_PER_STORY) {
    throw new UltragoalError(
      "TOO_MANY_CRITERIA",
      `a story may have at most ${MAX_CRITERIA_PER_STORY} criteria`,
    );
  }
  return {
    id: `G${String(index).padStart(3, "0")}`,
    title,
    objective,
    status: "pending",
    attempts: 0,
    criteria: rawCriteria.map((criterion, criterionIndex) => ({
      id: `C${String(criterionIndex + 1).padStart(3, "0")}`,
      text: requireText(criterion, "CRITERION_REQUIRED", "criterion", 500),
      evidence: [],
    })),
  };
}

function assertCriteriaCapacity(stories: UltragoalStory[]): void {
  const criterionCount = stories.reduce(
    (total, story) => total + story.criteria.length,
    0,
  );
  if (criterionCount > MAX_EVIDENCE_RECORDS) {
    throw new UltragoalError(
      "TOO_MANY_CRITERIA",
      `a plan may have at most ${MAX_EVIDENCE_RECORDS} criteria`,
    );
  }
}

function parseRalplanStories(text: string): StoryInput[] {
  const sections = [...text.matchAll(/^#{2,3}\s+(?:Story\s*:\s*)?(.+)$/gim)];
  const stories: StoryInput[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const match = sections[index]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = sections[index + 1]?.index ?? text.length;
    const body = text.slice(start, end).trim();
    const criteria = body
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+)$/)?.[1]?.trim())
      .filter((value): value is string => Boolean(value));
    const objective = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^[-*]\s+\[[ xX]\]/.test(line));
    stories.push({
      title: match[1]!.trim(),
      objective: objective ?? match[1]!.trim(),
      criteria,
    });
  }
  return stories;
}

function readSource(
  paths: UltragoalPaths,
  input: CreateUltragoalInput,
): {
  text: string;
  kind: "objective" | "ralplan";
  originalPath?: string;
  stories: StoryInput[];
} {
  if (!input.planFile) {
    const objective = requireText(input.objective, "OBJECTIVE_REQUIRED", "objective");
    return {
      text: `# Ultragoal Brief\n\n${objective}\n`,
      kind: "objective",
      stories: input.stories?.length
        ? input.stories
        : [{ title: "Complete the objective", objective }],
    };
  }
  const absolute = resolve(paths.root, input.planFile);
  const rel = relative(paths.root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UltragoalError("PLAN_PATH_INVALID", "Ralplan source must be inside the project");
  }
  const opened = openRegularFile(absolute, constants.O_RDONLY, {
    trustedRoot: paths.root,
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new UltragoalError("PLAN_PATH_INVALID", `cannot safely read Ralplan source: ${opened.reason}`);
  }
  try {
    if (fstatSync(opened.fd).size > MAX_SOURCE_BYTES) {
      throw new UltragoalError(
        "PLAN_PATH_INVALID",
        `Ralplan source exceeds ${MAX_SOURCE_BYTES} bytes`,
      );
    }
    const text = readFileSync(opened.fd, "utf8");
    const parsedStories = input.stories?.length ? input.stories : parseRalplanStories(text);
    if (!parsedStories.length) {
      throw new UltragoalError("STORIES_REQUIRED", "Ralplan source contains no story headings");
    }
    return {
      text,
      kind: "ralplan",
      originalPath: rel,
      stories: parsedStories,
    };
  } finally {
    closeSync(opened.fd);
  }
}

export function createUltragoal(input: CreateUltragoalInput): UltragoalManifest {
  const sessionId = requireText(input.sessionId, "SESSION_ID_REQUIRED", "sessionId", 500);
  const operationId = requireText(input.operationId, "OPERATION_ID_REQUIRED", "operationId", 500);
  const objective = requireText(input.objective, "OBJECTIVE_REQUIRED", "objective");
  const goalGeneration = input.goalGeneration === undefined
    ? undefined
    : requireText(input.goalGeneration, "GOAL_GENERATION_INVALID", "goalGeneration", 64);
  if (goalGeneration !== undefined && !SHA256_PATTERN.test(goalGeneration)) {
    throw new UltragoalError(
      "GOAL_GENERATION_INVALID",
      "goalGeneration must be a SHA-256 digest",
    );
  }
  const paths = ultragoalPaths(input.cwd, sessionId);
  const operationFingerprint = fingerprint({
    command: "create",
    sessionId,
    objective,
    goalGeneration,
    stories: input.stories,
    planFile: input.planFile,
  });

  return withLock(paths, () => {
    recoverPending(paths);
    if (existsSync(paths.manifest)) {
      const existing = readUnlocked(paths);
      if (checkOperation(existing, operationId, operationFingerprint)) return existing;
      throw new UltragoalError("ULTRAGOAL_EXISTS", "an Ultragoal plan already exists for this session");
    }

    const source = readSource(paths, input);
    if (source.stories.length > MAX_STORIES) {
      throw new UltragoalError(
        "TOO_MANY_STORIES",
        `a plan may have at most ${MAX_STORIES} stories`,
      );
    }
    ensureDir(paths.brief);
    atomicWrite(paths.brief, source.text);
    const now = new Date().toISOString();
    const stories = source.stories.map((story, index) => storyFromInput(story, index + 1));
    assertCriteriaCapacity(stories);
    const manifest: UltragoalManifest = {
      schemaVersion: 1,
      planId: randomUUID(),
      sessionId,
      sessionKey: paths.sessionKey,
      ...(goalGeneration ? { goalGeneration } : {}),
      objective,
      status: "active",
      revision: 0,
      activeStoryId: null,
      source: {
        kind: source.kind,
        sha256: sha256(source.text),
        snapshotPath: relative(paths.root, paths.brief),
        ...(source.originalPath ? { originalPath: source.originalPath } : {}),
      },
      stories,
      operations: {},
      lastLedgerHash: null,
      createdAt: now,
      updatedAt: now,
    };
    return commitMutation(
      paths,
      manifest,
      operationId,
      operationFingerprint,
      "plan_created",
      { storyIds: manifest.stories.map((story) => story.id), source: manifest.source },
    );
  });
}

function cloneManifest(manifest: UltragoalManifest): UltragoalManifest {
  return structuredClone(manifest);
}

function mutate(
  input: UltragoalMutationInput,
  command: string,
  fingerprintInput: Record<string, unknown>,
  callback: (manifest: UltragoalManifest) => {
    event: string;
    payload: Record<string, unknown>;
  },
): UltragoalManifest {
  const sessionId = requireText(input.sessionId, "SESSION_ID_REQUIRED", "sessionId", 500);
  const operationId = requireText(input.operationId, "OPERATION_ID_REQUIRED", "operationId", 500);
  const paths = ultragoalPaths(input.cwd, sessionId);
  const operationFingerprint = fingerprint({ command, sessionId, ...fingerprintInput });
  return withLock(paths, () => {
    const current = readUnlocked(paths);
    if (checkOperation(current, operationId, operationFingerprint)) return current;
    const manifest = cloneManifest(current);
    const change = callback(manifest);
    return commitMutation(
      paths,
      manifest,
      operationId,
      operationFingerprint,
      change.event,
      change.payload,
    );
  });
}

export function startNextUltragoalStory(
  input: UltragoalMutationInput,
): UltragoalManifest {
  return mutate(input, "start-next", {}, (manifest) => {
    if (manifest.status === "complete") {
      throw new UltragoalError("ULTRAGOAL_COMPLETE", "the plan is already complete");
    }
    if (manifest.activeStoryId) {
      throw new UltragoalError(
        "STORY_IN_PROGRESS",
        `${manifest.activeStoryId} must checkpoint before another story starts`,
      );
    }
    const story = manifest.stories.find((candidate) => candidate.status === "pending");
    if (!story) {
      throw new UltragoalError("NO_PENDING_STORY", "all stories await or passed the final gate");
    }
    story.status = "in_progress";
    story.attempts += 1;
    story.startedAt = new Date().toISOString();
    manifest.activeStoryId = story.id;
    manifest.status = "active";
    return { event: "story_started", payload: { storyId: story.id, attempt: story.attempts } };
  });
}

function findStory(manifest: UltragoalManifest, storyId: string): UltragoalStory {
  const story = manifest.stories.find((candidate) => candidate.id === storyId);
  if (!story) throw new UltragoalError("STORY_NOT_FOUND", `unknown story ${storyId}`);
  return story;
}

function safeEvidenceFile(
  paths: UltragoalPaths,
  file: string,
): { path: string; content: Buffer } {
  const absolute = resolve(paths.root, file);
  const rel = relative(paths.root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UltragoalError("EVIDENCE_PATH_INVALID", "evidence must be a project file");
  }
  const opened = openRegularFile(absolute, constants.O_RDONLY, {
    trustedRoot: paths.root,
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new UltragoalError(
      "EVIDENCE_PATH_INVALID",
      `cannot safely read evidence: ${opened.reason}`,
    );
  }
  try {
    if (fstatSync(opened.fd).size > MAX_EVIDENCE_BYTES) {
      throw new UltragoalError(
        "EVIDENCE_PATH_INVALID",
        `evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes`,
      );
    }
    return { path: rel, content: readFileSync(opened.fd) };
  } finally {
    closeSync(opened.fd);
  }
}

export function attachUltragoalEvidence(
  input: AttachEvidenceInput,
): UltragoalManifest {
  const summary = requireText(input.summary, "EVIDENCE_REQUIRED", "summary", 2_000);
  return mutate(
    input,
    "attach-evidence",
    {
      storyId: input.storyId,
      criterionId: input.criterionId,
      summary,
      file: input.file,
    },
    (manifest) => {
      const fileEvidence = input.file
        ? safeEvidenceFile(ultragoalPaths(input.cwd, input.sessionId), input.file)
        : undefined;
      const story = findStory(manifest, input.storyId);
      if (story.status !== "in_progress") {
        throw new UltragoalError("STORY_NOT_IN_PROGRESS", `${story.id} is ${story.status}`);
      }
      const criterion = story.criteria.find((candidate) => candidate.id === input.criterionId);
      if (!criterion) {
        throw new UltragoalError(
          "CRITERION_NOT_FOUND",
          `unknown criterion ${input.criterionId} for ${story.id}`,
        );
      }
      const evidenceCount = manifest.stories.reduce(
        (count, candidate) =>
          count + candidate.criteria.reduce((total, item) => total + item.evidence.length, 0),
        0,
      );
      if (evidenceCount >= MAX_EVIDENCE_RECORDS) {
        throw new UltragoalError(
          "TOO_MUCH_EVIDENCE",
          `a plan may record at most ${MAX_EVIDENCE_RECORDS} evidence items`,
        );
      }
      const evidence: UltragoalEvidence = {
        id: `E${String(evidenceCount + 1).padStart(4, "0")}`,
        criterionId: criterion.id,
        kind: fileEvidence ? "file" : "note",
        summary,
        ...(fileEvidence ? { path: fileEvidence.path } : {}),
        sha256: fileEvidence ? sha256(fileEvidence.content) : sha256(summary),
        planRevision: manifest.revision,
        recordedAt: new Date().toISOString(),
      };
      criterion.evidence.push(evidence);
      return {
        event: "criterion_evidence_attached",
        payload: {
          storyId: story.id,
          criterionId: criterion.id,
          evidenceId: evidence.id,
          sha256: evidence.sha256,
          path: evidence.path,
        },
      };
    },
  );
}

export function checkpointUltragoalStory(
  input: UltragoalMutationInput & { storyId: string },
): UltragoalManifest {
  return mutate(input, "checkpoint", { storyId: input.storyId }, (manifest) => {
    const story = findStory(manifest, input.storyId);
    if (story.status !== "in_progress" || manifest.activeStoryId !== story.id) {
      throw new UltragoalError("STORY_NOT_IN_PROGRESS", `${story.id} is not the active story`);
    }
    const missing = story.criteria.filter((criterion) => criterion.evidence.length === 0);
    if (missing.length) {
      throw new UltragoalError(
        "CRITERION_EVIDENCE_REQUIRED",
        `missing evidence for ${missing.map((criterion) => criterion.id).join(", ")}`,
      );
    }
    story.status = "complete";
    story.completedAt = new Date().toISOString();
    manifest.activeStoryId = null;
    manifest.status = manifest.stories.every(
      (candidate) => candidate.status === "complete" || candidate.status === "superseded",
    )
      ? "awaiting_gate"
      : "active";
    return { event: "story_completed", payload: { storyId: story.id } };
  });
}

function nextStoryIndex(manifest: UltragoalManifest): number {
  return (
    Math.max(
      0,
      ...manifest.stories.map((story) => Number(/^G(\d+)$/.exec(story.id)?.[1] ?? 0)),
    ) + 1
  );
}

export function steerUltragoal(input: SteerUltragoalInput): UltragoalManifest {
  const evidence = requireText(input.evidence, "STEERING_EVIDENCE_REQUIRED", "evidence", 2_000);
  const rationale = requireText(
    input.rationale,
    "STEERING_RATIONALE_REQUIRED",
    "rationale",
    2_000,
  );
  return mutate(
    input,
    "steer",
    {
      kind: input.kind,
      evidence,
      rationale,
      targetStoryId: input.targetStoryId,
      stories: input.stories,
      pendingOrder: input.pendingOrder,
      title: input.title,
      objective: input.objective,
      criteria: input.criteria,
    },
    (manifest) => {
      if (manifest.status === "complete") {
        throw new UltragoalError("ULTRAGOAL_COMPLETE", "completed plans cannot be steered");
      }
      let affected: string[];
      if (input.kind === "add") {
        if (!input.stories?.length) {
          throw new UltragoalError("STORIES_REQUIRED", "add steering requires stories");
        }
        let index = nextStoryIndex(manifest);
        const added = input.stories.map((story) => storyFromInput(story, index++));
        manifest.stories.push(...added);
        affected = added.map((story) => story.id);
      } else if (input.kind === "reorder") {
        const pending = manifest.stories.filter((story) => story.status === "pending");
        const requested = input.pendingOrder ?? [];
        if (
          requested.length !== pending.length
          || new Set(requested).size !== pending.length
          || pending.some((story) => !requested.includes(story.id))
        ) {
          throw new UltragoalError(
            "PENDING_ORDER_INVALID",
            "pendingOrder must contain every pending story exactly once",
          );
        }
        const byId = new Map(pending.map((story) => [story.id, story]));
        manifest.stories = [
          ...manifest.stories.filter((story) => story.status !== "pending"),
          ...requested.map((id) => byId.get(id)!),
        ];
        affected = requested;
      } else if (input.kind === "revise") {
        const story = findStory(
          manifest,
          requireText(input.targetStoryId, "TARGET_REQUIRED", "targetStoryId"),
        );
        if (story.status !== "pending") {
          throw new UltragoalError("STEERING_TARGET_INVALID", "only pending stories can be revised");
        }
        if (input.title) story.title = requireText(input.title, "STORY_TITLE_REQUIRED", "title", 200);
        if (input.objective) {
          story.objective = requireText(
            input.objective,
            "STORY_OBJECTIVE_REQUIRED",
            "objective",
          );
        }
        if (input.criteria?.length) {
          story.criteria = storyFromInput(
            {
              title: story.title,
              objective: story.objective,
              criteria: input.criteria,
            },
            1,
          ).criteria;
        }
        affected = [story.id];
      } else if (input.kind === "split") {
        const target = findStory(
          manifest,
          requireText(input.targetStoryId, "TARGET_REQUIRED", "targetStoryId"),
        );
        if (target.status !== "pending" || !input.stories || input.stories.length < 2) {
          throw new UltragoalError(
            "STEERING_TARGET_INVALID",
            "split requires a pending target and at least two replacement stories",
          );
        }
        let index = nextStoryIndex(manifest);
        const replacements = input.stories.map((story) => storyFromInput(story, index++));
        target.status = "superseded";
        target.supersededBy = replacements.map((story) => story.id);
        manifest.stories.push(...replacements);
        affected = [target.id, ...target.supersededBy];
      } else if (input.kind === "supersede") {
        const target = findStory(
          manifest,
          requireText(input.targetStoryId, "TARGET_REQUIRED", "targetStoryId"),
        );
        if (target.status === "complete" || target.status === "in_progress") {
          throw new UltragoalError(
            "STEERING_TARGET_INVALID",
            "complete or active stories cannot be superseded",
          );
        }
        target.status = "superseded";
        affected = [target.id];
      } else if (input.kind === "annotate") {
        affected = [];
      } else {
        throw new UltragoalError("STEERING_KIND_INVALID", `unknown steering kind ${input.kind}`);
      }
      if (manifest.stories.length > MAX_STORIES) {
        throw new UltragoalError(
          "TOO_MANY_STORIES",
          `a plan may have at most ${MAX_STORIES} stories`,
        );
      }
      assertCriteriaCapacity(manifest.stories);
      manifest.status = manifest.stories.every(
        (story) => story.status === "complete" || story.status === "superseded",
      )
        ? "awaiting_gate"
        : "active";
      delete manifest.lastGate;
      return {
        event: "steering_accepted",
        payload: { kind: input.kind, evidence, rationale, affected },
      };
    },
  );
}

export function applyUltragoalGate(
  input: UltragoalMutationInput & {
    gate: UltragoalGateResult;
  },
): UltragoalManifest {
  return mutate(
    input,
    "gate",
    {
      gateStatus: input.gate.status,
      planRevision: input.gate.planRevision,
      roles: input.gate.roles.map(({ role, verdict, outputSha256 }) => ({
        role,
        verdict,
        outputSha256,
      })),
    },
    (manifest) => {
      if (manifest.status !== "awaiting_gate") {
        throw new UltragoalError(
          "GATE_NOT_READY",
          `all non-superseded stories must be complete; plan is ${manifest.status}`,
        );
      }
      if (manifest.revision !== input.gate.planRevision) {
        throw new UltragoalError(
          "GATE_REVISION_STALE",
          `gate revision ${input.gate.planRevision} does not match ${manifest.revision}`,
        );
      }
      const artifactPath = input.gate.artifactPath;
      manifest.lastGate = {
        status: input.gate.status,
        planRevision: input.gate.planRevision,
        artifactPath,
        recordedAt: input.gate.createdAt,
      };
      if (input.gate.status === "passed") {
        const unfinished = manifest.stories.filter(
          (story) => story.status !== "complete" && story.status !== "superseded",
        );
        if (unfinished.length) {
          throw new UltragoalError(
            "STORIES_INCOMPLETE",
            `gate cannot pass with unfinished stories: ${unfinished.map((story) => story.id).join(", ")}`,
          );
        }
        manifest.status = "complete";
        return {
          event: "gate_passed",
          payload: { planRevision: input.gate.planRevision, artifactPath },
        };
      }

      let index = nextStoryIndex(manifest);
      const failedRoles = input.gate.roles.filter((role) => role.verdict !== "PASS");
      if (manifest.stories.length + failedRoles.length > MAX_STORIES) {
        throw new UltragoalError(
          "TOO_MANY_STORIES",
          `gate resolvers would exceed ${MAX_STORIES} stories`,
        );
      }
      for (const failed of failedRoles) {
        const resolver = storyFromInput(
          {
            title: `Resolve ${failed.role} gate at revision ${input.gate.planRevision}`,
            objective: `Resolve the ${failed.role} ${failed.verdict.toLowerCase()} result: ${failed.summary}`,
            criteria: [
              `The reported ${failed.role} issue is resolved with recorded evidence for a new gate`,
            ],
          },
          index++,
        );
        resolver.resolver = {
          role: failed.role,
          gateRevision: input.gate.planRevision,
        };
        manifest.stories.push(resolver);
      }
      assertCriteriaCapacity(manifest.stories);
      manifest.status = "active";
      return {
        event: "gate_blocked",
        payload: {
          planRevision: input.gate.planRevision,
          artifactPath,
          resolverStoryIds: manifest.stories
            .filter((story) => story.resolver?.gateRevision === input.gate.planRevision)
            .map((story) => story.id),
        },
      };
    },
  );
}
