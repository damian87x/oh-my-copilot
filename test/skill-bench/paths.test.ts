import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkillBenchOutputPath, resolveSkillBenchPaths, writeSkillBenchJsonAtomic } from "../../src/skill-bench/paths.js";

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "omp-skill-bench-project-"));
  home = mkdtempSync(path.join(tmpdir(), "omp-skill-bench-home-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("skill-bench paths", () => {
  it("resolves project and global .omp/skill-bench roots from injected cwd/home", () => {
    const paths = resolveSkillBenchPaths({ cwd, home });
    expect(paths.projectRoot).toBe(path.join(cwd, ".omp", "skill-bench"));
    expect(paths.globalRoot).toBe(path.join(home, ".omp", "skill-bench"));
    expect(paths.projectSpecsDir).toBe(path.join(cwd, ".omp", "skill-bench", "specs"));
    expect(paths.globalRunsDir).toBe(path.join(home, ".omp", "skill-bench", "runs"));
  });

  it("resolves project root through ompRoot when invoked from a nested cwd", () => {
    writeFileSync(path.join(cwd, "package.json"), "{}\n", "utf8");
    const nested = path.join(cwd, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const paths = resolveSkillBenchPaths({ cwd: nested, home });

    expect(paths.projectRoot).toBe(path.join(cwd, ".omp", "skill-bench"));
    expect(paths.projectSpecsDir).toBe(path.join(cwd, ".omp", "skill-bench", "specs"));
    expect(paths.projectRunsDir).toBe(path.join(cwd, ".omp", "skill-bench", "runs"));
  });

  it("blocks traversal, absolute output injection, and symlink escape", () => {
    const paths = resolveSkillBenchPaths({ cwd, home });
    expect(() => resolveSkillBenchOutputPath(paths, "project", "../escape.json")).toThrow(/unsafe relative path/);
    expect(() => resolveSkillBenchOutputPath(paths, "project", path.join(cwd, "abs.json"))).toThrow(/absolute output path/);

    symlinkSync(tmpdir(), path.join(cwd, ".omp-symlink"));
    expect(() => resolveSkillBenchOutputPath(paths, "project", path.join("..", ".omp-symlink", "x.json"))).toThrow(/unsafe relative path/);

    mkdirSync(paths.projectRoot, { recursive: true });
    symlinkSync(tmpdir(), path.join(paths.projectRoot, "link-out"));
    expect(() => resolveSkillBenchOutputPath(paths, "project", "link-out/x.json")).toThrow(/symlink escape blocked/);
  });

  it("atomically writes JSON only under the selected safe root", () => {
    const paths = resolveSkillBenchPaths({ cwd, home });
    const out = writeSkillBenchJsonAtomic(paths, "project", "runs/run-a/summary.json", { b: 1, a: 2 });
    expect(out).toBe(path.join(cwd, ".omp", "skill-bench", "runs", "run-a", "summary.json"));
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ a: 2, b: 1 });
    expect(lstatSync(out).isFile()).toBe(true);
  });

  it("rejects a symlinked project output root before writing outside the workspace", () => {
    const paths = resolveSkillBenchPaths({ cwd, home });
    const outside = path.join(home, "outside-skill-bench");
    mkdirSync(path.dirname(paths.projectRoot), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, paths.projectRoot);

    expect(() => writeSkillBenchJsonAtomic(paths, "project", "runs/escape.json", { escaped: true })).toThrow(/symlink root blocked/);
    expect(existsSync(path.join(outside, "runs", "escape.json"))).toBe(false);
  });

  it.each([
    ["project", () => cwd],
    ["global", () => home],
  ] as const)("rejects a symlinked %s .omp directory before creating skill-bench", (scope, baseForScope) => {
    const paths = resolveSkillBenchPaths({ cwd, home });
    const base = baseForScope();
    const outside = path.join(home, `outside-${scope}-omp`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(base, ".omp"));

    expect(() => writeSkillBenchJsonAtomic(paths, scope, "runs/escape.json", { escaped: true })).toThrow(/symlink escape blocked/);
    expect(existsSync(path.join(outside, "skill-bench", "runs", "escape.json"))).toBe(false);
  });
});
