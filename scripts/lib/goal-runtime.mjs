import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Pin path reads to one descriptor (dev+ino) so CodeQL TOCTOU alerts stay closed.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function readPinnedFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    return { fd, st, content: readFileSync(fd, "utf8") };
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    return undefined;
  }
}

const SCHEMA_VERSION = 1;
const REDUCER_VERSION = 1;
const INITIAL_TURN_GRANT = 20;
const HARD_TURN_LIMIT = 100;
const EXTENSION_TURNS = new Set([20, 40, 60, 80]);
const GENERATION_BOUND_COMMANDS = new Set(["complete", "extend", "turn"]);
const BLOCKER_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

export class GoalRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "GoalRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePathPart(value) {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe || "unknown";
}

function clearAgentStopDecisionCache(root, sessionId) {
  try {
    rmSync(
      join(
        ompRoot(root),
        ".omp",
        "state",
        "locks",
        `agentstop-decision-${safePathPart(sessionId)}.json`,
      ),
      { force: true },
    );
  } catch {
    // Best effort. A later cache expiry still recovers if the filesystem races.
  }
}

// RFC 8785-compatible for the JSON data types accepted by this runtime.
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GoalRuntimeError("INVALID_NUMBER", "JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new GoalRuntimeError("INVALID_JSON_VALUE", `Unsupported JSON value: ${typeof value}`);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseCanonicalJson(text, code, message) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GoalRuntimeError(code, message);
  }
  // This also rejects duplicate object keys: JSON.parse would collapse them,
  // making the re-serialized canonical form differ from the persisted record.
  if (canonicalJson(value) !== text) {
    throw new GoalRuntimeError(code, message);
  }
  return value;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function streamPaths(root, sessionId) {
  const normalizedRoot = ompRoot(root);
  const streamId = sha256(sessionId);
  const directory = join(normalizedRoot, ".omp", "state", "goals", streamId);
  return {
    directory,
    ledger: join(directory, "ledger.jsonl"),
    lock: join(directory, "aggregate.lock"),
    pending: join(directory, "pending.json"),
    snapshot: join(directory, "state.json"),
    streamId,
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function staleLock(path) {
  const pinned = readPinnedFile(path);
  if (!pinned) return undefined;
  try {
    const { st: stat, content } = pinned;
    let stale = false;
    try {
      const parsed = JSON.parse(content);
      const age = Date.now() - Date.parse(String(parsed.acquiredAt ?? ""));
      stale =
        !pidAlive(parsed.pid)
        || (Number.isFinite(age) && age > LOCK_STALE_AFTER_MS);
    } catch {
      stale = Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS;
    }
    return stale ? { dev: stat.dev, ino: stat.ino, content } : undefined;
  } finally {
    closeSync(pinned.fd);
  }
}

function recoveryClaimPrefix(path) {
  return `${basename(path)}.recovery-`;
}

function hasActiveRecoveryClaim(path) {
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

function claimObservedStaleLock(path, observed) {
  const claim = `${path}.recovery-${process.pid}-${randomUUID()}`;
  try {
    linkSync(path, claim);
  } catch {
    return false;
  }
  try {
    const claimed = readPinnedFile(claim);
    if (!claimed) return false;
    try {
      if (
        claimed.st.dev !== observed.dev
        || claimed.st.ino !== observed.ino
        || claimed.content !== observed.content
      ) {
        return false;
      }
      const current = readPinnedFile(path);
      if (!current) return true;
      try {
        if (
          current.st.dev === claimed.st.dev
          && current.st.ino === claimed.st.ino
          && current.content === observed.content
        ) {
          rmSync(path, { force: true });
        }
      } finally {
        closeSync(current.fd);
      }
    } finally {
      closeSync(claimed.fd);
    }
    return true;
  } finally {
    rmSync(claim, { force: true });
  }
}

function ownsCanonicalLock(path, descriptor, token) {
  try {
    const opened = fstatSync(descriptor);
    // Re-read path through a fresh descriptor and require the same inode as the
    // held lock fd (no path-string re-read after a separate lstat).
    const pinned = readPinnedFile(path);
    if (!pinned) return false;
    try {
      const metadata = JSON.parse(pinned.content);
      return (
        pinned.st.dev === opened.dev
        && pinned.st.ino === opened.ino
        && metadata.token === token
      );
    } finally {
      closeSync(pinned.fd);
    }
  } catch {
    return false;
  }
}

function removeOwnedCanonicalLock(path, token) {
  try {
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current.token === token) rmSync(path, { force: true });
  } catch {
    // Missing or replaced locks are not owned by this caller.
  }
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (hasActiveRecoveryClaim(path)) {
      throw new GoalRuntimeError("GOAL_BUSY", "Goal lock recovery is in progress", {
        retryable: true,
      });
    }
    let descriptor;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${canonicalJson({
          schemaVersion: SCHEMA_VERSION,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          token,
        })}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      if (hasActiveRecoveryClaim(path)) {
        removeOwnedCanonicalLock(path, token);
        throw new GoalRuntimeError("GOAL_BUSY", "Goal lock recovery is in progress", {
          retryable: true,
        });
      }
      if (!ownsCanonicalLock(path, descriptor, token)) {
        throw new GoalRuntimeError("GOAL_BUSY", "Goal lock ownership changed during recovery", {
          retryable: true,
        });
      }
      return { descriptor, token };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code === "EEXIST" && attempt === 0) {
        const observed = staleLock(path);
        if (observed && claimObservedStaleLock(path, observed)) continue;
      }
      if (error?.code === "EEXIST") {
        throw new GoalRuntimeError("GOAL_BUSY", "Goal state is locked by another operation", {
          retryable: true,
        });
      }
      throw error;
    }
  }
  throw new GoalRuntimeError("GOAL_BUSY", "Goal state is locked by another operation", {
    retryable: true,
  });
}

function releaseLock(path, lock) {
  closeSync(lock.descriptor);
  removeOwnedCanonicalLock(path, lock.token);
}

function initialState(sessionId, streamId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    reducerVersion: REDUCER_VERSION,
    sessionId,
    streamId,
    revision: 0,
    status: "empty",
    objective: "",
    turnCount: 0,
    grantedThrough: INITIAL_TURN_GRANT,
    extensionHistory: [],
    createdAt: null,
    updatedAt: null,
  };
}

function applyEvents(state, transaction) {
  const next = cloneJson(state);
  for (const event of transaction.events) {
    switch (event.type) {
      case "goal_created":
      case "goal_replaced":
        if (
          event.goalGeneration !== undefined
          && !SHA256_PATTERN.test(event.goalGeneration)
        ) {
          throw new GoalRuntimeError("LEDGER_CORRUPT", "Invalid Goal generation");
        }
        next.status = "active";
        next.objective = event.objective;
        next.turnCount = 0;
        next.grantedThrough = INITIAL_TURN_GRANT;
        next.extensionHistory = [];
        next.createdAt = transaction.occurredAt;
        next.goalGeneration = event.goalGeneration ?? transaction.eventHash;
        delete next.pauseReason;
        delete next.terminalReason;
        delete next.blocker;
        break;
      case "goal_edited":
        next.objective = event.objective;
        break;
      case "goal_paused":
        next.status = "paused";
        next.pauseReason = event.reason;
        break;
      case "goal_resumed":
        next.status = "active";
        delete next.pauseReason;
        break;
      case "goal_cleared":
        next.status = "cleared";
        next.terminalReason = event.reason;
        delete next.pauseReason;
        delete next.blocker;
        break;
      case "goal_completed":
        next.status = "complete";
        next.terminalReason = `agent-complete:${event.reason}`;
        delete next.pauseReason;
        delete next.blocker;
        break;
      case "goal_extended":
        next.grantedThrough = event.grantedThrough;
        next.extensionHistory.push({
          turn: event.turn,
          reason: event.reason,
        });
        break;
      case "goal_turn_recorded":
        next.status = event.status;
        next.turnCount = event.turnCount;
        next.grantedThrough = event.grantedThrough;
        if (event.blocker) next.blocker = event.blocker;
        else delete next.blocker;
        if (event.extensionReason) {
          next.extensionHistory.push({
            turn: event.turnCount,
            reason: event.extensionReason,
          });
        }
        if (event.pauseReason) next.pauseReason = event.pauseReason;
        else if (event.status !== "paused") delete next.pauseReason;
        if (event.terminalReason) next.terminalReason = event.terminalReason;
        else if (event.status === "active") delete next.terminalReason;
        break;
      case "goal_repaired":
        break;
      default:
        throw new GoalRuntimeError("LEDGER_CORRUPT", `Unknown Goal event: ${event.type}`);
    }
  }
  next.revision = transaction.revision;
  next.updatedAt = transaction.occurredAt;
  next.lastOperationId = transaction.operationId;
  next.lastEventHash = transaction.eventHash;
  return next;
}

function validateTransaction(transaction, paths, state, lineNumber) {
  const where = lineNumber ? ` at line ${lineNumber}` : "";
  if (
    !transaction
    || typeof transaction !== "object"
    || transaction.schemaVersion !== SCHEMA_VERSION
    || transaction.reducerVersion !== REDUCER_VERSION
    || transaction.sessionId !== state.sessionId
    || transaction.streamId !== paths.streamId
    || transaction.revision !== state.revision + 1
    || transaction.previousEventHash !== (state.lastEventHash ?? null)
    || !Array.isArray(transaction.events)
    || typeof transaction.operationId !== "string"
    || typeof transaction.operationFingerprint !== "string"
  ) {
    throw new GoalRuntimeError("LEDGER_CORRUPT", `Invalid ledger chain${where}`);
  }
  const { eventHash, ...hashInput } = transaction;
  if (typeof eventHash !== "string" || sha256(canonicalJson(hashInput)) !== eventHash) {
    throw new GoalRuntimeError("LEDGER_CORRUPT", `Invalid ledger hash${where}`);
  }
}

function parseLedger(paths, sessionId) {
  let state = initialState(sessionId, paths.streamId);
  const operations = new Map();
  let descriptor;
  try {
    descriptor = openSync(paths.ledger, constants.O_RDWR | NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") return { state, operations };
    throw new GoalRuntimeError(
      "LEDGER_CORRUPT",
      "Goal ledger is not a safe regular file",
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new GoalRuntimeError(
        "LEDGER_CORRUPT",
        "Goal ledger is not a safe regular file",
      );
    }
    let raw = readFileSync(descriptor, "utf8");
    if (!raw) return { state, operations };

    let completeRecordWithoutNewline = false;
    if (!raw.endsWith("\n")) {
      const lastNewline = raw.lastIndexOf("\n");
      const tail = raw.slice(lastNewline + 1);
      try {
        parseCanonicalJson(tail, "LEDGER_CORRUPT", "Invalid final ledger record");
        completeRecordWithoutNewline = true;
      } catch {
        const completeLength = lastNewline + 1;
        ftruncateSync(
          descriptor,
          Buffer.byteLength(raw.slice(0, completeLength), "utf8"),
        );
        fsyncSync(descriptor);
        raw = raw.slice(0, completeLength);
      }
    }

    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        throw new GoalRuntimeError(
          "LEDGER_CORRUPT",
          `Empty ledger record at line ${index + 1}`,
        );
      }
      const transaction = parseCanonicalJson(
        line,
        "LEDGER_CORRUPT",
        `Invalid ledger JSON at line ${index + 1}`,
      );
      validateTransaction(transaction, paths, state, index + 1);
      const generationEvent = transaction.events.find(
        (event) => event.type === "goal_created" || event.type === "goal_replaced",
      );
      const operationGeneration = generationEvent
        ? generationEvent.goalGeneration ?? transaction.eventHash
        : state.goalGeneration;
      const operationKey = `${operationGeneration ?? "none"}\0${transaction.operationId}`;
      if (operations.has(operationKey)) {
        throw new GoalRuntimeError(
          "LEDGER_CORRUPT",
          `Duplicate operation at line ${index + 1}`,
        );
      }
      state = applyEvents(state, transaction);
      operations.set(operationKey, {
        fingerprint: transaction.operationFingerprint,
        result: transaction.result,
        eventHash: transaction.eventHash,
      });
    }
    if (completeRecordWithoutNewline) {
      writeSync(descriptor, "\n", Buffer.byteLength(raw, "utf8"), "utf8");
      fsyncSync(descriptor);
    }
    return { state, operations };
  } finally {
    closeSync(descriptor);
  }
}

function readPending(paths) {
  if (!existsSync(paths.pending)) return undefined;
  const raw = readFileSync(paths.pending, "utf8");
  const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!text || text.includes("\n")) {
    throw new GoalRuntimeError("PENDING_CORRUPT", "Invalid pending Goal transaction");
  }
  return parseCanonicalJson(
    text,
    "PENDING_CORRUPT",
    "Invalid pending Goal transaction",
  );
}

function appendLedgerRecord(path, transaction) {
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new GoalRuntimeError(
        "LEDGER_CORRUPT",
        "Goal ledger is not a safe regular file",
      );
    }
    if (NOFOLLOW === 0) {
      const pathStat = lstatSync(path);
      if (
        pathStat.isSymbolicLink()
        || pathStat.dev !== stat.dev
        || pathStat.ino !== stat.ino
      ) {
        throw new GoalRuntimeError(
          "LEDGER_CORRUPT",
          "Goal ledger is not a safe regular file",
        );
      }
    }
    const record = Buffer.from(`${canonicalJson(transaction)}\n`, "utf8");
    let offset = 0;
    while (offset < record.length) {
      const written = writeSync(
        descriptor,
        record,
        offset,
        record.length - offset,
      );
      if (written <= 0) {
        throw new GoalRuntimeError("LEDGER_CORRUPT", "Goal ledger append made no progress");
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof GoalRuntimeError) throw error;
    throw new GoalRuntimeError(
      "LEDGER_CORRUPT",
      "Goal ledger is not a safe regular file",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function recover(paths, sessionId) {
  const aggregate = parseLedger(paths, sessionId);
  const pending = readPending(paths);
  if (!pending) return aggregate;

  const generationEvent = pending.events.find(
    (event) => event.type === "goal_created" || event.type === "goal_replaced",
  );
  const pendingGeneration = generationEvent
    ? generationEvent.goalGeneration ?? pending.eventHash
    : aggregate.state.goalGeneration;
  const pendingOperationKey = `${pendingGeneration ?? "none"}\0${pending.operationId}`;
  const recorded = aggregate.operations.get(pendingOperationKey);
  if (recorded) {
    if (recorded.eventHash !== pending.eventHash) {
      throw new GoalRuntimeError(
        "PENDING_CORRUPT",
        "Pending transaction conflicts with the durable ledger",
      );
    }
  } else {
    validateTransaction(pending, paths, aggregate.state);
    appendLedgerRecord(paths.ledger, pending);
    aggregate.state = applyEvents(aggregate.state, pending);
    aggregate.operations.set(pendingOperationKey, {
      fingerprint: pending.operationFingerprint,
      result: pending.result,
      eventHash: pending.eventHash,
    });
  }
  atomicWriteJson(paths.snapshot, aggregate.state);
  rmSync(paths.pending, { force: true });
  return aggregate;
}

function appendTransaction(
  paths,
  state,
  operationId,
  operationFingerprint,
  events,
  result,
) {
  const occurredAt = new Date().toISOString();
  const hashInput = {
    schemaVersion: SCHEMA_VERSION,
    reducerVersion: REDUCER_VERSION,
    streamId: paths.streamId,
    sessionId: state.sessionId,
    revision: state.revision + 1,
    operationId,
    operationFingerprint,
    occurredAt,
    events,
    result,
    previousEventHash: state.lastEventHash ?? null,
  };
  const transaction = { ...hashInput, eventHash: sha256(canonicalJson(hashInput)) };

  atomicWriteJson(paths.pending, transaction);
  appendLedgerRecord(paths.ledger, transaction);
  const nextState = applyEvents(state, transaction);
  atomicWriteJson(paths.snapshot, nextState);
  rmSync(paths.pending, { force: true });
  return nextState;
}

function publicState(state) {
  return {
    sessionId: state.sessionId,
    ...(state.goalGeneration ? { goalGeneration: state.goalGeneration } : {}),
    objective: state.objective,
    status: state.status,
    turnCount: state.turnCount,
    grantedThrough: state.grantedThrough,
    revision: state.revision,
    ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
    ...(state.terminalReason ? { terminalReason: state.terminalReason } : {}),
    ...(state.blocker ? { blocker: state.blocker } : {}),
    ...(state.extensionHistory.length > 0
      ? { extensionHistory: cloneJson(state.extensionHistory) }
      : {}),
  };
}

export function formatGoalContext(state) {
  if (!state || state.status === "empty") return "";
  const generationArg = state.goalGeneration
    ? ` --expected-goal-generation "${state.goalGeneration}"`
    : "";
  const heading = `[GOAL ${String(state.status).toUpperCase()}: turn ${state.turnCount}/${state.grantedThrough}]`;
  const lines = [
    heading,
    `Session: ${state.sessionId}`,
    `Objective: ${state.objective}`,
  ];
  if (state.status === "active") {
    const nextTurn = state.turnCount + 1;
    lines.push(
      "Continue autonomously until the objective is genuinely complete.",
      `Completion after fresh verification: run \`omp goal complete --reason "<evidence>" --session-id "${state.sessionId}" --operation-id "goal-complete-${nextTurn}"${generationArg} --json\`.`,
      "Also output OMP_GOAL_COMPLETE on its own line for transcript-capable runtimes.",
      'Stable blocker: output OMP_GOAL_BLOCKED {"key":"stable-slug"} on its own line; the same key must persist for 3 counted turns.',
    );
    if (
      EXTENSION_TURNS.has(state.grantedThrough)
      && nextTurn === state.grantedThrough
    ) {
      lines.push(
        `Before finishing turn ${state.grantedThrough}, continue only after running \`omp goal extend --reason "<specific remaining work>" --session-id "${state.sessionId}" --operation-id "goal-extend-${state.grantedThrough}"${generationArg} --json\`.`,
        'Also output OMP_GOAL_EXTEND {"reason":"specific remaining work"} on its own line for transcript-capable runtimes.',
      );
    }
  } else if (state.status === "paused" && state.pauseReason) {
    lines.push(`Paused: ${state.pauseReason}`);
  } else if (state.terminalReason) {
    lines.push(`Terminal reason: ${state.terminalReason}`);
  }
  return lines.join("\n");
}

function requireText(value, code, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new GoalRuntimeError(code, `${name} is required`);
  return text;
}

function requireUnfinished(state) {
  if (state.status !== "active" && state.status !== "paused") {
    throw new GoalRuntimeError("GOAL_NOT_ACTIVE", "This session has no unfinished Goal", {
      details: { status: state.status },
    });
  }
}

function operationFingerprint(input, command, sessionId) {
  return sha256(canonicalJson({
    command,
    sessionId,
    expectedGoalGeneration: input.expectedGoalGeneration,
    objective: input.objective,
    reason: input.reason,
    turnId: input.turnId,
    assistantText: input.assistantText,
  }));
}

function exactMarker(text, name) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line === name);
}

function jsonMarker(text, name) {
  const prefix = `${name} `;
  const line = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!line) return undefined;
  const payload = line.slice(prefix.length);
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function evaluateTurn(state, input) {
  if (state.status !== "active") {
    throw new GoalRuntimeError("GOAL_NOT_ACTIVE", "Goal must be active to count a turn", {
      details: { status: state.status },
    });
  }
  const turnId = requireText(input.turnId, "TURN_ID_REQUIRED", "turnId");
  const assistantText = String(input.assistantText ?? "");
  const turnCount = state.turnCount + 1;
  let status = "active";
  let grantedThrough = state.grantedThrough;
  let blocker;
  let extensionReason;
  let pauseReason;
  let terminalReason;

  if (exactMarker(assistantText, "OMP_GOAL_COMPLETE")) {
    status = "complete";
    terminalReason = "assistant-complete";
  } else {
    const blocked = jsonMarker(assistantText, "OMP_GOAL_BLOCKED");
    const blockerKey = typeof blocked?.key === "string" && BLOCKER_KEY.test(blocked.key)
      ? blocked.key
      : undefined;
    if (blockerKey) {
      blocker = {
        key: blockerKey,
        count: state.blocker?.key === blockerKey ? state.blocker.count + 1 : 1,
      };
      if (blocker.count >= 3) {
        status = "blocked";
        terminalReason = `blocker:${blockerKey}`;
      }
    }
  }

  if (status === "active" && turnCount >= HARD_TURN_LIMIT) {
    status = "blocked";
    terminalReason = "hard-turn-limit";
  } else if (
    status === "active"
    && turnCount === grantedThrough
    && EXTENSION_TURNS.has(turnCount)
  ) {
    const extension = jsonMarker(assistantText, "OMP_GOAL_EXTEND");
    extensionReason = typeof extension?.reason === "string"
      ? extension.reason.trim()
      : "";
    if (extensionReason) {
      grantedThrough = Math.min(HARD_TURN_LIMIT, grantedThrough + INITIAL_TURN_GRANT);
    } else {
      status = "paused";
      pauseReason = `extension-required-at-turn-${turnCount}`;
    }
  }

  const decision = status === "active" ? "block" : "allow";
  let reason;
  if (decision === "block") {
    const nextTurn = turnCount + 1;
    const generationArg = state.goalGeneration
      ? ` --expected-goal-generation "${state.goalGeneration}"`
      : "";
    reason =
      `[GOAL TURN ${turnCount}/${grantedThrough}] Continue "${state.objective}". `
      + `After fresh verification, complete with \`omp goal complete --reason "<evidence>" --session-id "${state.sessionId}" --operation-id "goal-complete-${nextTurn}"${generationArg} --json\`. `
      + 'If genuinely blocked, output OMP_GOAL_BLOCKED {"key":"stable-slug"} on its own line.';
    if (EXTENSION_TURNS.has(grantedThrough) && nextTurn === grantedThrough) {
      reason +=
        ` Before finishing turn ${grantedThrough}, continue only after running `
        + `\`omp goal extend --reason "<specific remaining work>" --session-id "${state.sessionId}" --operation-id "goal-extend-${grantedThrough}"${generationArg} --json\`.`;
    }
  }
  const event = {
    type: "goal_turn_recorded",
    turnId,
    turnCount,
    status,
    grantedThrough,
    blocker: blocker ?? null,
    extensionReason: extensionReason || undefined,
    pauseReason,
    terminalReason,
  };
  return { event, decision, reason };
}

function success(result) {
  return { schemaVersion: SCHEMA_VERSION, ok: true, result };
}

function failure(error) {
  const known = error instanceof GoalRuntimeError;
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: {
      code: known ? error.code : "GOAL_INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: known ? error.retryable : false,
      ...(known && error.details ? { details: error.details } : {}),
    },
  };
}

export function goalCommand(input) {
  let lock;
  let paths;
  try {
    const root = requireText(input.root, "ROOT_REQUIRED", "root");
    const sessionId = requireText(input.sessionId, "SESSION_ID_REQUIRED", "sessionId");
    const command = requireText(input.command, "COMMAND_REQUIRED", "command");
    paths = streamPaths(root, sessionId);
    lock = acquireLock(paths.lock);

    const { state, operations } = recover(paths, sessionId);
    if (command === "status") return success(publicState(state));

    const operationId = requireText(
      input.operationId,
      "OPERATION_ID_REQUIRED",
      "operationId",
    );
    if (
      state.goalGeneration
      && GENERATION_BOUND_COMMANDS.has(command)
      && input.expectedGoalGeneration === undefined
    ) {
      throw new GoalRuntimeError(
        "GOAL_GENERATION_REQUIRED",
        `${command} requires the active Goal generation`,
      );
    }
    if (input.expectedGoalGeneration !== undefined) {
      const expectedGoalGeneration = requireText(
        input.expectedGoalGeneration,
        "GOAL_GENERATION_INVALID",
        "expectedGoalGeneration",
      );
      if (!SHA256_PATTERN.test(expectedGoalGeneration)) {
        throw new GoalRuntimeError(
          "GOAL_GENERATION_INVALID",
          "expectedGoalGeneration must be a SHA-256 digest",
        );
      }
      if (state.goalGeneration !== expectedGoalGeneration) {
        throw new GoalRuntimeError(
          "GOAL_GENERATION_MISMATCH",
          "The active Goal generation no longer matches this operation",
          {
            details: {
              expectedGoalGeneration,
              actualGoalGeneration: state.goalGeneration,
            },
          },
        );
      }
    }
    const fingerprint = operationFingerprint(input, command, sessionId);
    const currentGeneration =
      (command === "set" || command === "create")
      && state.status !== "active"
      && state.status !== "paused"
        ? undefined
        : state.goalGeneration;
    const prior = currentGeneration
      ? operations.get(`${currentGeneration}\0${operationId}`)
      : undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new GoalRuntimeError(
          "OPERATION_COLLISION",
          "operationId was already used with different input",
        );
      }
      return success(prior.result);
    }

    let events;
    let result;
    if (command === "set" || command === "create") {
      const objective = requireText(input.objective, "OBJECTIVE_REQUIRED", "objective");
      if (state.status === "active" || state.status === "paused") {
        throw new GoalRuntimeError("GOAL_EXISTS", "This session already has an unfinished Goal", {
          details: { status: state.status, objective: state.objective },
        });
      }
      const goalGeneration = sha256(randomUUID());
      events = [{ type: "goal_created", objective, goalGeneration }];
      result = {
        sessionId,
        goalGeneration,
        objective,
        status: "active",
        turnCount: 0,
        grantedThrough: INITIAL_TURN_GRANT,
        revision: state.revision + 1,
      };
    } else if (command === "edit") {
      requireUnfinished(state);
      const objective = requireText(input.objective, "OBJECTIVE_REQUIRED", "objective");
      events = [{ type: "goal_edited", objective }];
      result = { ...publicState(state), objective, revision: state.revision + 1 };
    } else if (command === "pause") {
      if (state.status !== "active") {
        throw new GoalRuntimeError("GOAL_NOT_ACTIVE", "Only an active Goal can be paused");
      }
      const reason = requireText(input.reason, "REASON_REQUIRED", "reason");
      events = [{ type: "goal_paused", reason }];
      result = {
        ...publicState(state),
        status: "paused",
        pauseReason: reason,
        revision: state.revision + 1,
      };
    } else if (command === "resume") {
      if (state.status !== "paused") {
        throw new GoalRuntimeError("GOAL_NOT_PAUSED", "Only a paused Goal can be resumed");
      }
      if (state.pauseReason === `extension-required-at-turn-${state.grantedThrough}`) {
        throw new GoalRuntimeError(
          "GOAL_EXTENSION_REQUIRED",
          `Extend the Goal at turn ${state.grantedThrough} before resuming`,
        );
      }
      events = [{ type: "goal_resumed" }];
      const { pauseReason: _pauseReason, ...rest } = publicState(state);
      result = { ...rest, status: "active", revision: state.revision + 1 };
    } else if (command === "replace") {
      requireUnfinished(state);
      const objective = requireText(input.objective, "OBJECTIVE_REQUIRED", "objective");
      const goalGeneration = sha256(randomUUID());
      events = [{ type: "goal_replaced", objective, goalGeneration }];
      result = {
        sessionId,
        goalGeneration,
        objective,
        status: "active",
        turnCount: 0,
        grantedThrough: INITIAL_TURN_GRANT,
        revision: state.revision + 1,
      };
    } else if (command === "clear") {
      requireUnfinished(state);
      const reason = requireText(input.reason, "REASON_REQUIRED", "reason");
      events = [{ type: "goal_cleared", reason }];
      result = {
        ...publicState(state),
        status: "cleared",
        terminalReason: reason,
        revision: state.revision + 1,
      };
      delete result.blocker;
      delete result.pauseReason;
    } else if (command === "complete") {
      if (state.status !== "active") {
        throw new GoalRuntimeError("GOAL_NOT_ACTIVE", "Only an active Goal can be completed");
      }
      const reason = requireText(input.reason, "REASON_REQUIRED", "reason");
      events = [{ type: "goal_completed", reason }];
      result = {
        ...publicState(state),
        status: "complete",
        terminalReason: `agent-complete:${reason}`,
        revision: state.revision + 1,
      };
      delete result.blocker;
      delete result.pauseReason;
    } else if (command === "extend") {
      const recoveringBoundaryPause =
        state.status === "paused"
        && state.turnCount === state.grantedThrough
        && state.pauseReason === `extension-required-at-turn-${state.grantedThrough}`;
      if (state.status !== "active" && !recoveringBoundaryPause) {
        throw new GoalRuntimeError("GOAL_NOT_ACTIVE", "Only an active Goal can be extended");
      }
      const boundary = state.grantedThrough;
      const dueDuringTurn = state.status === "active" && state.turnCount === boundary - 1;
      if (!EXTENSION_TURNS.has(boundary) || (!dueDuringTurn && !recoveringBoundaryPause)) {
        throw new GoalRuntimeError(
          "GOAL_EXTENSION_NOT_DUE",
          `Goal extension is available only during turn ${boundary}`,
          {
            details: {
              turnCount: state.turnCount,
              grantedThrough: boundary,
            },
          },
        );
      }
      const reason = requireText(input.reason, "REASON_REQUIRED", "reason");
      const grantedThrough = Math.min(HARD_TURN_LIMIT, boundary + INITIAL_TURN_GRANT);
      events = [
        {
          type: "goal_extended",
          turn: boundary,
          reason,
          grantedThrough,
        },
        ...(recoveringBoundaryPause ? [{ type: "goal_resumed" }] : []),
      ];
      result = {
        ...publicState(state),
        status: "active",
        grantedThrough,
        extensionHistory: [
          ...state.extensionHistory,
          { turn: boundary, reason },
        ],
        revision: state.revision + 1,
      };
      delete result.pauseReason;
    } else if (command === "turn") {
      const turn = evaluateTurn(state, input);
      events = [turn.event];
      result = {
        ...publicState(state),
        status: turn.event.status,
        turnCount: turn.event.turnCount,
        grantedThrough: turn.event.grantedThrough,
        revision: state.revision + 1,
        decision: turn.decision,
        ...(turn.reason ? { reason: turn.reason } : {}),
        ...(turn.event.blocker ? { blocker: turn.event.blocker } : {}),
        ...(turn.event.pauseReason ? { pauseReason: turn.event.pauseReason } : {}),
        ...(turn.event.terminalReason ? { terminalReason: turn.event.terminalReason } : {}),
      };
      if (!turn.event.blocker) delete result.blocker;
    } else if (command === "repair") {
      events = [{ type: "goal_repaired" }];
      result = { ...publicState(state), revision: state.revision + 1, repaired: true };
    } else {
      throw new GoalRuntimeError("UNKNOWN_GOAL_COMMAND", `Unknown Goal command: ${command}`);
    }

    appendTransaction(paths, state, operationId, fingerprint, events, result);
    if (command !== "turn") clearAgentStopDecisionCache(root, sessionId);
    return success(result);
  } catch (error) {
    return failure(error);
  } finally {
    if (lock !== undefined && paths) releaseLock(paths.lock, lock);
  }
}

export const goalRuntimeInternals = {
  canonicalJson,
  streamPaths,
};
