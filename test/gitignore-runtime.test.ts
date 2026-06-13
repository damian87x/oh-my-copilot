import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("runtime state ignores", () => {
  it("keeps .omp runtime state untracked because raw tool output may be sensitive", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(".omp/");
  });
});
