import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMBERS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MIN_SURVIVORS,
  DEFAULT_SYNTHESIZER,
  loadCouncilConfig,
} from "../../src/council/config.js";

describe("loadCouncilConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "council-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(council: unknown): void {
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "config.json"), JSON.stringify({ council }), "utf8");
  }

  it("returns the built-in defaults when no config file exists", () => {
    const cfg = loadCouncilConfig({ question: "q" }, { cwd: dir });
    expect(cfg.members).toEqual(DEFAULT_MEMBERS);
    expect(cfg.synthesizerModel).toBe(DEFAULT_SYNTHESIZER);
    expect(cfg.minSurvivors).toBe(DEFAULT_MIN_SURVIVORS);
    expect(cfg.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(cfg.probe).toBe(false);
  });

  it("parses a council block from .omp/config.json", () => {
    writeConfig({
      synthesizer: "gpt-5-mini",
      minSurvivors: 1,
      perMemberTimeoutMs: 5000,
      maxConcurrency: 2,
      probe: true,
      members: [{ model: "claude-haiku-4.5", role: "critic", weight: 0.6 }],
    });
    const cfg = loadCouncilConfig({ question: "q" }, { cwd: dir });
    expect(cfg.synthesizerModel).toBe("gpt-5-mini");
    expect(cfg.minSurvivors).toBe(1);
    expect(cfg.perMemberTimeoutMs).toBe(5000);
    expect(cfg.maxConcurrency).toBe(2);
    expect(cfg.probe).toBe(true);
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].model).toBe("claude-haiku-4.5");
  });

  it("drops malformed member entries from config", () => {
    writeConfig({
      members: [
        { model: "good", role: "critic", weight: 1 },
        { model: "", role: "x", weight: 1 }, // empty model
        { model: "noweight", role: "y" }, // missing weight
        { model: "negative", role: "z", weight: -1 }, // bad weight
      ],
    });
    const cfg = loadCouncilConfig({ question: "q" }, { cwd: dir });
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].model).toBe("good");
  });

  it("spec.members override config and defaults", () => {
    writeConfig({ members: [{ model: "fromconfig", role: "critic", weight: 1 }] });
    const cfg = loadCouncilConfig(
      { question: "q", members: [{ model: "fromspec", role: "critic", weight: 1 }] },
      { cwd: dir },
    );
    expect(cfg.members[0].model).toBe("fromspec");
  });

  it("spec.probe overrides config.probe (precedence)", () => {
    writeConfig({ probe: true });
    const cfg = loadCouncilConfig({ question: "q", probe: false }, { cwd: dir });
    expect(cfg.probe).toBe(false);
  });

  it("tolerates an unreadable/invalid config file", () => {
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(join(dir, ".omp", "config.json"), "{ not json", "utf8");
    const cfg = loadCouncilConfig({ question: "q" }, { cwd: dir });
    expect(cfg.members).toEqual(DEFAULT_MEMBERS);
  });
});
