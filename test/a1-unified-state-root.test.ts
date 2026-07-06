import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modeStatePath } from "../src/mode-state/paths.js";
import { startRalph } from "../src/mode-state/ralph.js";
import { resolveSchedulePaths } from "../src/schedule/paths.js";
import { stateRead, stateWrite } from "../src/state.js";
import { resolveTeamPaths } from "../src/team/state-paths.js";
// @ts-expect-error - plain .mjs hook script exports are exercised as public hook handlers.
import { handleAgentStop } from "../scripts/agent-stop.mjs";
// @ts-expect-error - plain .mjs hook script exports are exercised as public hook handlers.
import { handlePromptSubmit } from "../scripts/prompt-submit.mjs";
// @ts-expect-error - plain .mjs hook script exports are exercised as public hook handlers.
import { handleSessionStart } from "../scripts/session-start.mjs";

interface Fixture {
  root: string;
  subdir: string;
}

const fixtures: string[] = [];

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "omp-a1-root-"));
  fixtures.push(root);
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  const subdir = path.join(root, "packages", "service", "src");
  mkdirSync(subdir, { recursive: true });
  return { root, subdir };
}

type HookHandler = (raw: string) => Record<string, unknown> | Promise<Record<string, unknown>>;

async function runHook(handler: HookHandler, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return handler(JSON.stringify(payload));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function seedVersionCache(root: string): void {
  const stateDir = path.join(root, ".omp", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "version-check.json"),
    JSON.stringify({ checkedAt: Date.now(), latest: "0.0.0" }),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("A1 unified .omp state root", () => {
  it("uses the repository root for mode-state, hooks, schedule, KV, and team from a subdirectory", async () => {
    const { root, subdir } = makeFixture();
    const rootRalph = path.join(root, ".omp", "state", "ralph.json");
    const nestedRalph = path.join(subdir, ".omp", "state", "ralph.json");

    startRalph({ cwd: subdir, prompt: "fix auth", maxIterations: 3, sessionId: "s1" });

    expect(modeStatePath(subdir, "ralph")).toBe(rootRalph);
    expect(existsSync(rootRalph)).toBe(true);
    expect(existsSync(nestedRalph)).toBe(false);

    const promptOut = await runHook(handlePromptSubmit, { cwd: subdir, prompt: "continue", sessionId: "s1" });
    expect(String(promptOut.additionalContext)).toContain("[RALPH ACTIVE: iteration 0/3]");

    seedVersionCache(root);
    await runHook(handleSessionStart, { cwd: subdir, sessionId: "s1" });

    const stopOut = await runHook(handleAgentStop, { cwd: subdir, sessionId: "s1" });
    expect(stopOut.decision).toBe("block");
    expect(readJson(rootRalph).iteration).toBe(1);
    expect(existsSync(nestedRalph)).toBe(false);

    const hooksLog = readFileSync(path.join(root, ".omp", "state", "hooks.log"), "utf8");
    expect(hooksLog).toContain('"hook":"UserPromptSubmit"');
    expect(hooksLog).toContain('"hook":"SessionStart"');
    expect(hooksLog).toContain('"hook":"agentStop"');
    expect(existsSync(path.join(subdir, ".omp", "state", "hooks.log"))).toBe(false);

    const schedulePaths = resolveSchedulePaths(subdir);
    expect(schedulePaths.cwd).toBe(root);
    expect(schedulePaths.jobsDir).toBe(path.join(root, ".omp", "state", "schedule", "jobs"));

    stateWrite(subdir, "shared", { ok: true });
    expect(stateRead(root, "shared").value).toEqual({ ok: true });
    expect(existsSync(path.join(root, ".omp", "state", "kv", "shared.json"))).toBe(true);
    expect(existsSync(path.join(subdir, ".omp", "state", "kv", "shared.json"))).toBe(false);

    const teamPaths = resolveTeamPaths(subdir, "demo");
    expect(teamPaths.cwd).toBe(root);
    expect(teamPaths.teamRoot).toBe(path.join(root, ".omp", "state", "team", "demo"));
  });

  it("session-start warns about nested state and non-empty nested schedule jobs", async () => {
    const { root, subdir } = makeFixture();
    seedVersionCache(root);
    const nestedState = path.join(subdir, ".omp", "state");
    const nestedJobs = path.join(nestedState, "schedule", "jobs");
    mkdirSync(nestedJobs, { recursive: true });
    writeFileSync(path.join(nestedState, "ralph.json"), JSON.stringify({ active: true }), "utf8");
    writeFileSync(path.join(nestedJobs, "stale.json"), JSON.stringify({ id: "stale" }), "utf8");

    const out = await runHook(handleSessionStart, { cwd: subdir, sessionId: "s2" });
    const context = String(out.additionalContext);
    expect(context).toContain("Nested .omp/state found");
    expect(context).toContain(nestedState);
    expect(context).toContain("Non-empty nested schedule jobs found");
    expect(context).toContain(nestedJobs);
    expect(context).toContain(path.join(root, ".omp", "state", "schedule", "jobs"));
  });
});
