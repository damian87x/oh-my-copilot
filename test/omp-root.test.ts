import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ompRoot } from "../src/omp-root.js";

describe("ompRoot", () => {
  it("walks up from a nested dir to the nearest .git project", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "omp-root-"));
    const proj = path.join(ws, "projA");
    const deep = path.join(proj, "src", "deep");
    mkdirSync(path.join(proj, ".git"), { recursive: true });
    mkdirSync(deep, { recursive: true });
    expect(ompRoot(deep)).toBe(proj);
    expect(ompRoot(proj)).toBe(proj); // idempotent at the root
  });

  it("uses package.json when there is no .git", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "omp-root-"));
    const proj = path.join(ws, "projB");
    const sub = path.join(proj, "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(proj, "package.json"), "{}");
    expect(ompRoot(sub)).toBe(proj);
  });

  it("returns an ancestor-or-self when no marker is found", () => {
    const bare = mkdtempSync(path.join(tmpdir(), "omp-bare-"));
    const root = ompRoot(bare);
    expect(bare.startsWith(root)).toBe(true);
  });
});
