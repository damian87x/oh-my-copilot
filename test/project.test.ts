import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectPaths } from "../src/project.js";

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "omp-project-root-"));
}

describe("resolveProjectPaths", () => {
  it("does not use a package.json above the nearest Git repository", () => {
    const parent = tempRoot();
    writeFileSync(path.join(parent, "package.json"), '{"name":"home"}');
    const repo = path.join(parent, "workspace");
    const cwd = path.join(repo, "apps", "example");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    expect(resolveProjectPaths({ cwd }).packageRoot).toBe(repo);
  });

  it("keeps the nearest package.json when it is inside the Git repository", () => {
    const parent = tempRoot();
    writeFileSync(path.join(parent, "package.json"), '{"name":"home"}');
    const repo = path.join(parent, "workspace");
    const app = path.join(repo, "apps", "example");
    const cwd = path.join(app, "src");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(app, "package.json"), '{"name":"example"}');

    expect(resolveProjectPaths({ cwd }).packageRoot).toBe(app);
  });

  it("preserves nearest-package discovery outside Git repositories", () => {
    const root = tempRoot();
    const cwd = path.join(root, "nested", "directory");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"name":"standalone"}');

    expect(resolveProjectPaths({ cwd }).packageRoot).toBe(root);
  });
});
