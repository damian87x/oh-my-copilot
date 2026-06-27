import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_INSTRUCTIONS_TOPIC_TITLES,
  DEFAULT_REVIEW_MODEL,
  readMemoryConfig,
  setMemoryConfigValue,
} from "../../src/memory-review/config.js";

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
    expect(cfg.instructionsMemoryTopicTitles).toBe(DEFAULT_INSTRUCTIONS_TOPIC_TITLES);
  });

  it("reads a custom min-messages threshold", () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "memoryReviewMinMessages", "2");
    expect(readMemoryConfig(cwd).memoryReviewMinMessages).toBe(2);
  });

  it("reads a custom instructions memory topic title cap", () => {
    const cwd = root();
    setMemoryConfigValue(cwd, "instructionsMemoryTopicTitles", "3");
    expect(readMemoryConfig(cwd).instructionsMemoryTopicTitles).toBe(3);
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

  it("reads global (home ~/.omp) config when project has none", () => {
    const cwd = root();
    const home = root();
    setMemoryConfigValue(cwd, "memoryReviewModel", "home-cheap", { scope: "global", homeDir: home });
    // written to <home>/.omp/config.json, NOT the project
    expect(JSON.parse(readFileSync(path.join(home, ".omp", "config.json"), "utf8")).memoryReviewModel).toBe("home-cheap");
    expect(readMemoryConfig(cwd, { homeDir: home }).memoryReviewModel).toBe("home-cheap");
  });

  it("reads the topic title cap from global ~/.omp config", () => {
    const cwd = root();
    const home = root();
    setMemoryConfigValue(cwd, "instructionsMemoryTopicTitles", "4", { scope: "global", homeDir: home });
    expect(readMemoryConfig(cwd, { homeDir: home }).instructionsMemoryTopicTitles).toBe(4);
  });

  it("project config overrides global, per key", () => {
    const cwd = root();
    const home = root();
    setMemoryConfigValue(cwd, "memoryReviewModel", "home-model", { scope: "global", homeDir: home });
    setMemoryConfigValue(cwd, "memoryMode", "on", { scope: "global", homeDir: home });
    setMemoryConfigValue(cwd, "memoryReviewModel", "project-model"); // project (default scope)
    const cfg = readMemoryConfig(cwd, { homeDir: home });
    expect(cfg.memoryReviewModel).toBe("project-model"); // project wins
    expect(cfg.memoryMode).toBe("on"); // inherited from global
  });

  it("env still overrides both project and global", () => {
    const cwd = root();
    const home = root();
    setMemoryConfigValue(cwd, "memoryMode", "off", { scope: "global", homeDir: home });
    process.env.OMP_MEMORY_MODE = "on";
    expect(readMemoryConfig(cwd, { homeDir: home }).memoryMode).toBe("on");
  });
});
