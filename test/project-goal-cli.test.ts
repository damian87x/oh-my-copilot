import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function project(): string {
  return mkdtempSync(join(tmpdir(), "omp-project-goal-"));
}

describe("project-goal CLI", () => {
  it("sets and reads the existing repository objective without changing its storage path", async () => {
    const root = project();

    const set = await runCli(["project-goal", "set", "Ship Goal v1", "--root", root, "--json"]);
    const read = await runCli(["project-goal", "read", "--root", root, "--json"]);

    expect(set).toMatchObject({ ok: true, output: { schemaVersion: 1, ok: true, result: { goal: "Ship Goal v1" } } });
    expect(read).toMatchObject({ ok: true, output: { schemaVersion: 1, ok: true, result: { goal: "Ship Goal v1" } } });
    expect(readFileSync(join(root, ".omp", "goal.md"), "utf8")).toBe("# Repo Goal\n\nShip Goal v1\n");
  });

  it("clears the repository objective", async () => {
    const root = project();
    await runCli(["project-goal", "set", "Temporary", "--root", root]);

    const cleared = await runCli(["project-goal", "clear", "--root", root, "--json"]);
    const read = await runCli(["project-goal", "read", "--root", root, "--json"]);

    expect(cleared).toMatchObject({ ok: true, output: { schemaVersion: 1, ok: true, result: { cleared: true } } });
    expect(read).toMatchObject({ ok: true, output: { schemaVersion: 1, ok: true, result: { goal: "" } } });
  });

  it("returns a structured JSON error when the project Goal cannot be written", async () => {
    const root = project();
    const notDirectory = join(root, "not-a-directory");
    writeFileSync(notDirectory, "file\n", "utf8");

    const result = await runCli([
      "project-goal",
      "set",
      "Cannot be stored",
      "--root",
      notDirectory,
      "--json",
    ]);

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      output: {
        schemaVersion: 1,
        ok: false,
        error: {
          code: "PROJECT_GOAL_WRITE_FAILED",
          retryable: false,
        },
      },
    });
  });
});
