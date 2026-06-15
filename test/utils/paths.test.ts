import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ompPath, statePath } from "../../src/utils/paths.js";

describe("ompPath", () => {
  it("returns path to .omp directory when no segments", () => {
    const result = ompPath("/project");
    expect(result).toBe(join("/project", ".omp"));
  });

  it("joins segments within .omp directory", () => {
    const result = ompPath("/project", "goal.md");
    expect(result).toBe(join("/project", ".omp", "goal.md"));
  });

  it("handles multiple segments", () => {
    const result = ompPath("/project", "memory", "daily", "2024-01-15.md");
    expect(result).toBe(join("/project", ".omp", "memory", "daily", "2024-01-15.md"));
  });

  it("handles nested project paths", () => {
    const result = ompPath("/home/user/projects/my-app", "config.json");
    expect(result).toBe(join("/home/user/projects/my-app", ".omp", "config.json"));
  });
});

describe("statePath", () => {
  it("returns path to .omp/state directory when no segments", () => {
    const result = statePath("/project");
    expect(result).toBe(join("/project", ".omp", "state"));
  });

  it("joins segments within .omp/state directory", () => {
    const result = statePath("/project", "kv", "key.json");
    expect(result).toBe(join("/project", ".omp", "state", "kv", "key.json"));
  });

  it("handles single segment", () => {
    const result = statePath("/project", "cache");
    expect(result).toBe(join("/project", ".omp", "state", "cache"));
  });

  it("handles nested project paths", () => {
    const result = statePath("/home/user/workspace/app", "data.db");
    expect(result).toBe(join("/home/user/workspace/app", ".omp", "state", "data.db"));
  });
});
