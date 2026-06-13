import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function runHook(script, payload, cwd) {
  return JSON.parse(
    execFileSync(process.execPath, [join(process.cwd(), "scripts", script)], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf8",
    }),
  );
}

describe("hook cwd normalization", () => {
  let payloadRoot;
  let processRoot;

  beforeEach(() => {
    payloadRoot = mkdtempSync(join(tmpdir(), "omp-hook-payload-root-"));
    processRoot = mkdtempSync(join(tmpdir(), "omp-hook-process-root-"));
    writeFileSync(join(payloadRoot, "package.json"), "{}\n");
    writeFileSync(join(processRoot, "package.json"), "{}\n");
  });

  afterEach(() => {
    rmSync(payloadRoot, { recursive: true, force: true });
    rmSync(processRoot, { recursive: true, force: true });
  });

  it("pre/session/error hooks write state under documented payload cwd, not process cwd", () => {
    const payload = { sessionId: "cwd-s1", cwd: payloadRoot, toolName: "bash", error: "boom" };

    expect(runHook("pre-tool-use.mjs", payload, processRoot)).toEqual({});
    expect(runHook("session-end.mjs", payload, processRoot)).toEqual({});
    expect(runHook("error.mjs", payload, processRoot)).toEqual({});

    const payloadLog = readFileSync(join(payloadRoot, ".omp", "state", "hooks.log"), "utf8");
    expect(payloadLog).toContain('"sessionId":"cwd-s1"');
    expect(() => readFileSync(join(processRoot, ".omp", "state", "hooks.log"), "utf8")).toThrow();
  });
});
