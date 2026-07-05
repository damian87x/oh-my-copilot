import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompRoot } from "../../scripts/lib/omp-root.mjs";

const fixtures = [];

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/lib/omp-root.mjs", () => {
  it("walks up to the nearest .git marker", () => {
    const root = tempRoot("omp-script-root-git-");
    const project = join(root, "repo");
    const nested = join(project, "apps", "web");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(ompRoot(nested)).toBe(project);
  });

  it("walks up to package.json when there is no .git marker", () => {
    const root = tempRoot("omp-script-root-package-");
    const project = join(root, "repo");
    const nested = join(project, "packages", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}\n", "utf8");

    expect(ompRoot(nested)).toBe(project);
  });

  it("falls back to the start directory when no marker is found", () => {
    const bare = resolve("/", `omp-script-root-bare-${process.pid}-${Date.now()}`);
    expect(ompRoot(bare)).toBe(bare);
  });
});
