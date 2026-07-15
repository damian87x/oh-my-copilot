import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type EvaluatorFailureLabelV1 =
  | "answer-quality"
  | "skill-not-applied"
  | "infrastructure/tool"
  | "unavailable/quota/policy"
  | "scorer/reference"
  | "incomplete-evidence"
  | "parity-invalid";

const LABELS = new Set<EvaluatorFailureLabelV1>([
  "answer-quality",
  "skill-not-applied",
  "infrastructure/tool",
  "unavailable/quota/policy",
  "scorer/reference",
  "incomplete-evidence",
  "parity-invalid",
]);

export interface EvaluatorResultV1 {
  schemaVersion: 1;
  label: EvaluatorFailureLabelV1;
  score: number;
  proofMatrix: {
    expected: string[];
    found: string[];
    done: string[];
    missed: string[];
    falsePositive: string[];
    incorrect: string[];
    proof: string[];
  };
  evidence: Array<{ path: string }>;
}

export interface FrozenEvaluatorDescriptorV1 {
  schemaVersion: 1;
  path: string;
  sha256: string;
  provenance: string;
  approvedRoot?: string;
}

type EvaluatorSpawnInfo = {
  shell: false;
  cwd: string;
  env: Record<string, string>;
  evaluator: FrozenEvaluatorDescriptorV1;
  isolation: "restricted" | "best-effort";
  isolationMechanisms: string[];
};

export function validateEvaluatorResultV1(input: unknown, evidenceRoot: string, declaredEvidence: Array<{ path: string; sha256: string }> = []): { ok: true; value: EvaluatorResultV1 } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["result must be object"] };
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1) errors.push("unsupported schema version");
  if (typeof record.label !== "string" || !LABELS.has(record.label as EvaluatorFailureLabelV1)) errors.push("unknown label");
  if (typeof record.score !== "number" || !Number.isFinite(record.score)) errors.push("non-finite score");
  validateProofMatrix(record.proofMatrix, errors);
  const declaredPaths = new Set(declaredEvidence.map((item) => path.resolve(evidenceRoot, item.path)));
  if (!Array.isArray(record.evidence)) {
    errors.push("missing evidence");
  } else {
    for (const pointer of record.evidence) {
      if (typeof pointer !== "object" || pointer === null || Array.isArray(pointer) || typeof (pointer as { path?: unknown }).path !== "string") {
        errors.push("invalid evidence pointer");
        continue;
      }
      const pointerPath = (pointer as { path: string }).path;
      const resolvedPointer = path.resolve(evidenceRoot, pointerPath);
      if (!isInside(evidenceRoot, resolvedPointer)) errors.push("evidence pointer escapes declared root");
      if (!declaredPaths.has(resolvedPointer)) errors.push("evidence pointer was not declared");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: record as unknown as EvaluatorResultV1 };
}

export async function runEvaluatorV1(input: {
  command: { argv: string[]; evaluator: FrozenEvaluatorDescriptorV1 };
  request: { schemaVersion: 1; cellId: string; declaredEvidence: Array<{ path: string; sha256: string }>; evaluator: FrozenEvaluatorDescriptorV1 };
  evidenceRoot: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  envAllowlist: Record<string, string>;
}): Promise<
  | { status: "ok"; result: EvaluatorResultV1; spawn: EvaluatorSpawnInfo }
  | { status: "scorer-failure"; errors: string[]; spawn: EvaluatorSpawnInfo }
> {
  const cwd = mkdtempSync(
    path.join(realpathSync(tmpdir()), "omp-evaluator-"),
  );
  const networkRestricted =
    process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
  const spawnInfo: EvaluatorSpawnInfo = {
    shell: false,
    cwd,
    env: { ...input.envAllowlist },
    evaluator: input.command.evaluator,
    isolation: networkRestricted ? "restricted" : "best-effort",
    isolationMechanisms: [
      "isolated evaluator copy",
      "isolated read-only evidence copies",
      "node filesystem and child-process permissions",
      ...(networkRestricted ? ["darwin network sandbox"] : []),
    ],
  };
  const failure = (errors: string[]) => ({
    status: "scorer-failure" as const,
    errors,
    spawn: spawnInfo,
  });
  try {
    if (input.command.argv.length === 0) return failure(["missing argv"]);
    const evaluatorCheck = verifyFrozenEvaluatorDescriptor(
      input.command.evaluator,
      input.request.evaluator,
      input.evidenceRoot,
    );
    if (!evaluatorCheck.ok) return failure(evaluatorCheck.errors);
    const commandCheck = verifyEvaluatorCommand(
      input.command.argv,
      input.command.evaluator,
    );
    if (!commandCheck.ok) return failure(commandCheck.errors);
    if (!isNodeEvaluatorCommand(input.command.argv, input.command.evaluator)) {
      return failure([
        "restricted evaluator execution requires a Node evaluator command",
      ]);
    }
    const before = hashDeclaredEvidence(
      input.request.declaredEvidence,
      input.evidenceRoot,
      "before evaluator spawn",
    );
    if (!before.ok) return failure(before.errors);

    const isolated = prepareIsolatedEvaluatorInput({
      cwd,
      descriptor: input.command.evaluator,
      declaredEvidence: input.request.declaredEvidence,
    });
    if (!isolated.ok) return failure(isolated.errors);
    const permissionFlag = nodePermissionFlag();
    if (!permissionFlag) {
      return failure(["Node permission model is unavailable; evaluator refused"]);
    }
    const nodeArgv = [
      process.execPath,
      permissionFlag,
      `--allow-fs-read=${cwd}`,
      `--allow-fs-write=${isolated.outputRoot}`,
      isolated.evaluator.path,
      ...input.command.argv.slice(2),
    ];
    const argv = networkRestricted
      ? [
          "/usr/bin/sandbox-exec",
          "-p",
          "(version 1)(allow default)(deny network*)",
          ...nodeArgv,
        ]
      : nodeArgv;
    const request = {
      ...input.request,
      evaluator: isolated.evaluator,
      declaredEvidence: isolated.declaredEvidence,
    };
    const raw = await spawnJson(
      argv,
      JSON.stringify(request),
      cwd,
      input.envAllowlist,
      input.timeoutMs,
      input.maxStdoutBytes,
    );
    const originalAfter = hashDeclaredEvidence(
      input.request.declaredEvidence,
      input.evidenceRoot,
      "after evaluator spawn",
    );
    const originalMutation = mutationErrors(before.value, originalAfter);
    if (originalMutation.length > 0) return failure(originalMutation);
    const isolatedAfter = hashDeclaredEvidence(
      isolated.declaredEvidence,
      isolated.evidenceRoot,
      "after evaluator spawn",
    );
    const isolatedMutation = mutationErrors(
      isolated.beforeHashes,
      isolatedAfter,
    );
    if (isolatedMutation.length > 0) return failure(isolatedMutation);
    if (!raw.ok) return failure(raw.errors);
    const validation = validateEvaluatorResultV1(
      raw.value,
      isolated.evidenceRoot,
      isolated.declaredEvidence,
    );
    if (!validation.ok) return failure(validation.errors);
    return {
      status: "ok",
      result: remapEvaluatorResult(validation.value, isolated.pathMap),
      spawn: spawnInfo,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateProofMatrix(value: unknown, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("missing proof matrix");
    return;
  }
  const matrix = value as Record<string, unknown>;
  for (const key of [
    "expected",
    "found",
    "done",
    "missed",
    "falsePositive",
    "incorrect",
    "proof",
  ]) {
    const entries = matrix[key];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      errors.push(`invalid proof matrix ${key}`);
    }
  }
}

function verifyEvaluatorCommand(
  argv: string[],
  descriptor: FrozenEvaluatorDescriptorV1,
): { ok: true } | { ok: false; errors: string[] } {
  const evaluatorPath = path.resolve(descriptor.path);
  const direct = path.resolve(argv[0]) === evaluatorPath;
  const nodeRuntime =
    argv.length >= 2 &&
    path.resolve(argv[1]) === evaluatorPath &&
    ["node", "node.exe"].includes(path.basename(argv[0]).toLowerCase());
  return direct || nodeRuntime
    ? { ok: true }
    : { ok: false, errors: ["evaluator argv is not bound to frozen descriptor path"] };
}

function isNodeEvaluatorCommand(
  argv: string[],
  descriptor: FrozenEvaluatorDescriptorV1,
): boolean {
  return (
    argv.length >= 2 &&
    path.resolve(argv[1]) === path.resolve(descriptor.path) &&
    ["node", "node.exe"].includes(path.basename(argv[0]).toLowerCase())
  );
}

function nodePermissionFlag(): string | null {
  if (process.allowedNodeEnvironmentFlags.has("--permission")) {
    return "--permission";
  }
  if (process.allowedNodeEnvironmentFlags.has("--experimental-permission")) {
    return "--experimental-permission";
  }
  return null;
}

function prepareIsolatedEvaluatorInput(input: {
  cwd: string;
  descriptor: FrozenEvaluatorDescriptorV1;
  declaredEvidence: Array<{ path: string; sha256: string }>;
}):
  | {
      ok: true;
      evaluator: FrozenEvaluatorDescriptorV1;
      evidenceRoot: string;
      outputRoot: string;
      declaredEvidence: Array<{ path: string; sha256: string }>;
      beforeHashes: Map<string, string>;
      pathMap: Map<string, string>;
    }
  | { ok: false; errors: string[] } {
  try {
    const evaluatorPath = path.join(input.cwd, "evaluator.mjs");
    const evidenceRoot = path.join(input.cwd, "evidence");
    const outputRoot = path.join(input.cwd, "output");
    mkdirSync(evidenceRoot, { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    copyFileSync(input.descriptor.path, evaluatorPath);
    makeReadOnly(evaluatorPath);
    const pathMap = new Map<string, string>();
    const declaredEvidence = input.declaredEvidence.map((item, index) => {
      const safeName = path
        .basename(item.path)
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      const isolatedPath = path.join(
        evidenceRoot,
        `${String(index + 1).padStart(4, "0")}-${safeName || "evidence"}`,
      );
      copyFileSync(item.path, isolatedPath);
      makeReadOnly(isolatedPath);
      pathMap.set(isolatedPath, item.path);
      return { path: isolatedPath, sha256: item.sha256 };
    });
    const before = hashDeclaredEvidence(
      declaredEvidence,
      evidenceRoot,
      "before evaluator spawn",
    );
    if (!before.ok) return { ok: false, errors: before.errors };
    return {
      ok: true,
      evaluator: {
        ...input.descriptor,
        path: evaluatorPath,
        approvedRoot: input.cwd,
      },
      evidenceRoot,
      outputRoot,
      declaredEvidence,
      beforeHashes: before.value,
      pathMap,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        `failed to prepare isolated evaluator inputs: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function makeReadOnly(filePath: string): void {
  try {
    chmodSync(filePath, 0o444);
  } catch {
    // Node permissions still prevent evaluator writes on platforms without chmod.
  }
}

function remapEvaluatorResult(
  result: EvaluatorResultV1,
  pathMap: Map<string, string>,
): EvaluatorResultV1 {
  const remap = (value: string): string => pathMap.get(path.resolve(value)) ?? value;
  return {
    ...result,
    proofMatrix: {
      ...result.proofMatrix,
      proof: result.proofMatrix.proof.map(remap),
    },
    evidence: result.evidence.map((pointer) => ({ path: remap(pointer.path) })),
  };
}

export function buildBlindedJudgeRequest(input: {
  judgeModelId: string;
  candidateModelId: string;
  candidates: Array<{ candidateId: string; arm: string; modelId: string; answer: string }>;
}): { judgeModelId: string; candidates: Array<{ blindedId: string; answer: string }> } {
  if (input.judgeModelId === input.candidateModelId) throw new Error("candidate cannot judge itself");
  return {
    judgeModelId: input.judgeModelId,
    candidates: input.candidates.map((candidate, index) => ({ blindedId: `candidate-${index + 1}`, answer: candidate.answer })),
  };
}

function verifyFrozenEvaluatorDescriptor(
  commandDescriptor: FrozenEvaluatorDescriptorV1,
  requestDescriptor: FrozenEvaluatorDescriptorV1,
  evidenceRoot: string,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const [label, descriptor] of [["command", commandDescriptor], ["request", requestDescriptor]] as const) {
    if (!descriptor || descriptor.schemaVersion !== 1) errors.push(`${label} evaluator descriptor missing schemaVersion 1`);
    if (!descriptor || typeof descriptor.path !== "string" || descriptor.path === "") errors.push(`${label} evaluator descriptor missing path`);
    if (!descriptor || !/^[a-f0-9]{64}$/i.test(descriptor.sha256)) errors.push(`${label} evaluator descriptor invalid sha256`);
    if (!descriptor || typeof descriptor.provenance !== "string" || descriptor.provenance === "") errors.push(`${label} evaluator descriptor missing provenance`);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (commandDescriptor.path !== requestDescriptor.path || commandDescriptor.sha256.toLowerCase() !== requestDescriptor.sha256.toLowerCase() || commandDescriptor.provenance !== requestDescriptor.provenance) {
    errors.push("evaluator descriptor mismatch between command and request");
  }
  const approvedRoot = requestDescriptor.approvedRoot ?? evidenceRoot;
  if (!isInside(approvedRoot, requestDescriptor.path)) errors.push("evaluator path escapes approved root");
  try {
    const rootReal = realpathSync(approvedRoot);
    const evaluatorReal = realpathSync(requestDescriptor.path);
    if (!isInside(rootReal, evaluatorReal)) errors.push("evaluator realpath escapes approved root");
    const actual = createHash("sha256").update(readFileSync(evaluatorReal)).digest("hex");
    if (actual !== requestDescriptor.sha256.toLowerCase()) errors.push("evaluator sha256 mismatch");
  } catch (error) {
    errors.push(`evaluator unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function spawnJson(
  argv: string[],
  stdin: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  maxStdoutBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; errors: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, errors: ["evaluator timeout"] });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxStdoutBytes && !settled) {
        settled = true;
        child.kill("SIGKILL");
        clearTimeout(timer);
        resolve({ ok: false, errors: ["evaluator stdout cap exceeded"] });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, errors: [error.message] });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, errors: [`evaluator exited ${code}`, stderr.trim()].filter(Boolean) });
        return;
      }
      try {
        const value = JSON.parse(stdout.trim());
        resolve({ ok: true, value });
      } catch (error) {
        resolve({ ok: false, errors: [error instanceof Error ? error.message : "malformed evaluator JSON"] });
      }
    });
    child.stdin.end(stdin);
  });
}

function hashDeclaredEvidence(
  evidence: Array<{ path: string; sha256: string }>,
  evidenceRoot: string,
  phase: "before evaluator spawn" | "after evaluator spawn",
): { ok: true; value: Map<string, string> } | { ok: false; errors: string[]; actual: Map<string, string> } {
  const errors: string[] = [];
  const actual = new Map<string, string>();
  for (const item of evidence) {
    if (!isInside(evidenceRoot, item.path)) {
      errors.push(`declared evidence path escapes declared root ${phase}: ${item.path}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/i.test(item.sha256)) {
      errors.push(`declared evidence invalid sha256 ${phase}: ${item.path}`);
      continue;
    }
    try {
      const current = createHash("sha256").update(readFileSync(item.path)).digest("hex");
      actual.set(item.path, current);
      if (current !== item.sha256.toLowerCase()) errors.push(`declared evidence hash mismatch ${phase}: ${item.path}`);
    } catch (error) {
      errors.push(`declared evidence unreadable ${phase}: ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors, actual } : { ok: true, value: actual };
}

function mutationErrors(
  before: Map<string, string>,
  after: { ok: true; value: Map<string, string> } | { ok: false; errors: string[]; actual: Map<string, string> },
): string[] {
  const errors = after.ok ? [] : [...after.errors];
  const afterHashes = after.ok ? after.value : after.actual;
  if (!sameHashes(before, afterHashes)) errors.push("evaluator mutated declared input");
  return errors;
}

function sameHashes(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
