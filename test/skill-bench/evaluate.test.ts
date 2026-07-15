import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBlindedJudgeRequest,
  runEvaluatorV1,
  validateEvaluatorResultV1,
} from "../../src/skill-bench/evaluate.js";

const tempRoot = () => mkdtempSync(path.join(tmpdir(), "omp-skill-bench-evaluate-"));

function writeEvaluator(root: string, source: string): string {
  const file = path.join(root, "evaluator.mjs");
  writeFileSync(file, source);
  return file;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function evaluatorDescriptor(file: string, approvedRoot: string) {
  return {
    schemaVersion: 1 as const,
    path: file,
    sha256: sha256File(file),
    provenance: "test-fixture",
    approvedRoot,
  };
}

describe("skill-bench evaluator protocol v1", () => {
  const proofMatrix = {
    expected: ["expected"],
    found: ["expected"],
    done: ["expected"],
    missed: [],
    falsePositive: [],
    incorrect: [],
    proof: ["answer.txt"],
  };

  it("requires evaluator-owned proof matrices instead of deriving proof from a scalar score", () => {
    const root = tempRoot();
    const evidence = path.join(root, "answer.txt");
    writeFileSync(evidence, "answer");

    expect(validateEvaluatorResultV1({
      schemaVersion: 1,
      label: "answer-quality",
      score: 1,
      evidence: [{ path: evidence }],
    }, root, [{ path: evidence, sha256: sha256("answer") }]).ok).toBe(false);
  });

  it("runs evaluator by direct argv with temp cwd allowlisted env one stdin JSON and one stdout JSON", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    writeFileSync(declared, "candidate answer");
    const evaluator = writeEvaluator(root, `
      import { readFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 0.8, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [{ path: input.declaredEvidence[0].path }] }));
    `);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: evaluatorDescriptor(evaluator, root) },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: evaluatorDescriptor(evaluator, root), declaredEvidence: [{ path: declared, sha256: sha256("candidate answer") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.result.label).toBe("answer-quality");
      expect(result.spawn.shell).toBe(false);
      expect(result.spawn.cwd).not.toBe(process.cwd());
      expect(Object.keys(result.spawn.env)).toEqual(["PATH"]);
      expect(result.spawn.isolation).toMatch(/restricted/);
    }
  });

  it("binds the spawned evaluator argv to the frozen descriptor path", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    writeFileSync(declared, "answer");
    const approved = writeEvaluator(root, `process.stdout.write(JSON.stringify({schemaVersion:1,label:'answer-quality',score:1,proofMatrix:${JSON.stringify(proofMatrix)},evidence:[]}));`);
    const marker = path.join(root, "wrong-evaluator-ran");
    const wrongRoot = path.join(root, "wrong");
    mkdirSync(wrongRoot);
    const wrong = writeEvaluator(wrongRoot, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const descriptor = evaluatorDescriptor(approved, root);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, wrong], evaluator: descriptor },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: descriptor, declaredEvidence: [{ path: declared, sha256: sha256("answer") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails scorer on malformed extra unknown non-finite path escaping and input mutation", async () => {
    expect(validateEvaluatorResultV1({ schemaVersion: 1, label: "mystery", score: 1, evidence: [] }, "/tmp/root").ok).toBe(false);
    expect(validateEvaluatorResultV1({ schemaVersion: 1, label: "answer-quality", score: Number.NaN, evidence: [] }, "/tmp/root").ok).toBe(false);
    expect(validateEvaluatorResultV1({ schemaVersion: 1, label: "answer-quality", score: 1, evidence: [{ path: "/tmp/escape" }] }, "/tmp/root").ok).toBe(false);

    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    writeFileSync(declared, "before");
    const evaluator = writeEvaluator(root, `
      import { readFileSync, writeFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      writeFileSync(input.declaredEvidence[0].path, 'after');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [] }));
    `);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: evaluatorDescriptor(evaluator, root) },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: evaluatorDescriptor(evaluator, root), declaredEvidence: [{ path: declared, sha256: sha256("before") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(readFileSync(declared, "utf8")).toBe("before");
  });

  it("rejects scorer evidence pointers that were not declared in the request", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    const undeclared = path.join(evidenceRoot, "extra.txt");
    writeFileSync(declared, "candidate answer");
    writeFileSync(undeclared, "extra evidence");
    const evaluator = writeEvaluator(root, `
      import { readFileSync } from 'node:fs';
      JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 0.8, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [{ path: ${JSON.stringify(undeclared)} }] }));
    `);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: evaluatorDescriptor(evaluator, root) },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: evaluatorDescriptor(evaluator, root), declaredEvidence: [{ path: declared, sha256: sha256("candidate answer") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(result.errors).toEqual(expect.arrayContaining(["evidence pointer was not declared"]));
  });

  it("fails closed before spawn when evaluator descriptor hash is stale", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    const marker = path.join(root, "spawned-descriptor.txt");
    writeFileSync(declared, "candidate answer");
    const evaluator = writeEvaluator(root, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'spawned');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [] }));
    `);
    const descriptor = { ...evaluatorDescriptor(evaluator, root), sha256: sha256("stale") };

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: descriptor },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: descriptor, declaredEvidence: [{ path: declared, sha256: sha256("candidate answer") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(result.errors).toEqual(expect.arrayContaining(["evaluator sha256 mismatch"]));
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed before spawn when declared evidence hash is stale", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    const marker = path.join(root, "spawned.txt");
    writeFileSync(declared, "current");
    const evaluator = writeEvaluator(root, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'spawned');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [] }));
    `);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: evaluatorDescriptor(evaluator, root) },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: evaluatorDescriptor(evaluator, root), declaredEvidence: [{ path: declared, sha256: sha256("stale") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("declared evidence hash mismatch before evaluator spawn")]));
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed after spawn when evaluator tampers with declared evidence hash", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    mkdirSync(evidenceRoot);
    const declared = path.join(evidenceRoot, "answer.txt");
    writeFileSync(declared, "before");
    const evaluator = writeEvaluator(root, `
      import { readFileSync, writeFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      writeFileSync(input.declaredEvidence[0].path, 'tampered');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [] }));
    `);

    const result = await runEvaluatorV1({
      command: { argv: [process.execPath, evaluator], evaluator: evaluatorDescriptor(evaluator, root) },
      request: { schemaVersion: 1, cellId: "cell-a", evaluator: evaluatorDescriptor(evaluator, root), declaredEvidence: [{ path: declared, sha256: sha256("before") }] },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(readFileSync(declared, "utf8")).toBe("before");
  });

  it("runs only isolated copies and prevents evaluator mutation of sibling OMP state", async () => {
    const root = tempRoot();
    const evidenceRoot = path.join(root, "evidence");
    const stateRoot = path.join(root, ".omp", "skill-bench", "specs", "frozen");
    mkdirSync(evidenceRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    const declared = path.join(evidenceRoot, "answer.txt");
    const protectedManifest = path.join(stateRoot, "manifest.json");
    writeFileSync(declared, "candidate answer");
    writeFileSync(protectedManifest, '{"status":"frozen"}\n');
    const evaluator = writeEvaluator(root, `
      import { readFileSync, writeFileSync } from 'node:fs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      writeFileSync(${JSON.stringify(protectedManifest)}, '{"status":"mutated"}');
      process.stdout.write(JSON.stringify({ schemaVersion: 1, label: 'answer-quality', score: 1, proofMatrix: ${JSON.stringify(proofMatrix)}, evidence: [{ path: input.declaredEvidence[0].path }] }));
    `);

    const result = await runEvaluatorV1({
      command: {
        argv: [process.execPath, evaluator],
        evaluator: evaluatorDescriptor(evaluator, root),
      },
      request: {
        schemaVersion: 1,
        cellId: "cell-state-attack",
        evaluator: evaluatorDescriptor(evaluator, root),
        declaredEvidence: [
          { path: declared, sha256: sha256("candidate answer") },
        ],
      },
      evidenceRoot,
      timeoutMs: 2_000,
      maxStdoutBytes: 20_000,
      envAllowlist: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe("scorer-failure");
    expect(readFileSync(protectedManifest, "utf8")).toBe(
      '{"status":"frozen"}\n',
    );
    expect(readFileSync(declared, "utf8")).toBe("candidate answer");
  });

  it("rejects candidate self-judge and blinds candidate identities", () => {
    expect(() => buildBlindedJudgeRequest({ judgeModelId: "gpt-5.5", candidateModelId: "gpt-5.5", candidates: [] })).toThrow(/candidate cannot judge itself/);
    const request = buildBlindedJudgeRequest({
      judgeModelId: "gpt-5.6-terra",
      candidateModelId: "gpt-5.5",
      candidates: [
        { candidateId: "baseline:gpt-5.5", arm: "baseline", modelId: "gpt-5.5", answer: "A" },
        { candidateId: "skill:gpt-5.5", arm: "skill", modelId: "gpt-5.5", answer: "B" },
      ],
    });

    expect(JSON.stringify(request)).not.toContain("baseline");
    expect(JSON.stringify(request)).not.toContain("skill");
    expect(JSON.stringify(request)).not.toContain("gpt-5.5");
    expect(request.candidates.map((candidate) => candidate.blindedId)).toEqual(["candidate-1", "candidate-2"]);
  });
});
