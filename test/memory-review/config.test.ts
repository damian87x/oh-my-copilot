import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_REVIEW_MODEL, readMemoryConfig, setMemoryConfigValue } from "../../src/memory-review/config.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-mem-cfg-"));

afterEach(() => {
  delete process.env.OMP_MEMORY_MODE;
});

describe("memory-review config", () => {
  it("defaults to off with the default review model and min-messages threshold", () => {
    const cfg = readMemoryConfig(root());
    expect(cfg.memoryMode).toBe("off");
    expect(cfg.memoryReviewModel).toBe(DEFAULT_REVIEW_MODEL);
    expect(cfg.memoryReviewMinMessages).toBe(4);
  });

  it("reads a custom min-messages threshold", () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryReviewMinMessages", "2");
    expect(readMemoryConfig(cwd).memoryReviewMinMessages).toBe(2);
  });

  it("persists memoryMode and a custom model without clobbering other keys", () => {
    const cwd = root();
    mkdirSync(path.join(cwd, ".omp"), { recursive: true });
    writeFileSync(path.join(cwd, ".omp", "config.json"), JSON.stringify({ hooksEnabled: true }), "utf8");

    setMemoryConfigValue(cwd, "memoryMode", "on");
    setMemoryConfigValue(cwd, "memoryReviewModel", "haiku-cheap");

    const cfg = readMemoryConfig(cwd);
    expect(cfg.memoryMode).toBe("on");
    expect(cfg.memoryReviewModel).toBe("haiku-cheap");
    expect(JSON.parse(readFileSync(path.join(cwd, ".omp", "config.json"), "utf8")).hooksEnabled).toBe(true);
  });

  it("env override wins over file config", () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryMode", "off");
    process.env.OMP_MEMORY_MODE = "on";
    expect(readMemoryConfig(cwd).memoryMode).toBe("on");
  });
});
