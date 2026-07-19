import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRegisteredCommand, registeredCommandHelpLines } from "../../src/commands/registry.js";
import { parseSkillRetroArgs, skillRetroCommand } from "../../src/commands/skill-retro.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("skill-retro command", () => {
  it("is registered with defaults for weak-model use", () => {
    expect(findRegisteredCommand("skill-retro")).toBe(skillRetroCommand);
    expect(findRegisteredCommand("retro")).toBe(skillRetroCommand);
    expect(registeredCommandHelpLines().join("\n")).toContain("skill-retro");
  });

  it("defaults to simple 14d all none", () => {
    expect(parseSkillRetroArgs(["skill-retro"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseSkillRetroArgs(["skill-retro", "advanced", "--days", "7", "current"])).toEqual({
      window: "7d",
      project: "current",
      price: "none",
      view: "advanced",
      htmlPath: null,
      htmlDefault: false,
    });
    // README documents bare day counts: `/skill-retro 14` / `/skill-retro 30`
    expect(parseSkillRetroArgs(["skill-retro", "14"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    expect(parseSkillRetroArgs(["skill-retro", "30", "current"])).toEqual({
      window: "30d",
      project: "current",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    // Alias argv must strip `retro` the same way as `skill-retro`.
    expect(parseSkillRetroArgs(["retro", "7", "current"])).toEqual({
      window: "7d",
      project: "current",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    // Bare `all` is the time window (same as history analyze), not a no-op.
    expect(parseSkillRetroArgs(["skill-retro", "all"])).toEqual({
      window: "all",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
    // After a window is set, trailing `all` is the project scope.
    expect(parseSkillRetroArgs(["skill-retro", "14d", "all"])).toEqual({
      window: "14d",
      project: "all",
      price: "none",
      view: "simple",
      htmlPath: null,
      htmlDefault: false,
    });
  });

  it("prints skill-retro-v1 markdown tables without JSON", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-missing-skill-retro-home";
    try {
      const result = await skillRetroCommand.run(["skill-retro"], {
        cwd: "/repo",
        json: false,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Skill history — simple");
      expect(result.message).toContain("### Top skills");
      expect(result.message).toContain("### API usage");
      expect(result.message).toContain("### What next?");
      expect(result.message).toContain("More detail");
      expect(result.message).toContain("Show dollar estimates");
      expect(result.message).toContain("Save as HTML");
      expect(result.message).not.toContain("reportFormat:");
      expect(result.message).not.toMatch(/Next: advanced \|/);
      expect(result.message).not.toContain("### Session-level usage");
      expect(result.message).not.toMatch(/<th>USD \(credits\)<\/th>/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("writes HTML when --html is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-skill-retro-"));
    tempDirs.push(dir);
    const out = join(dir, "r.html");
    const previousHome = process.env.HOME;
    process.env.HOME = join(dir, "missing-home");
    try {
      const result = await skillRetroCommand.run(["skill-retro", "--html", out], {
        cwd: dir,
        json: false,
      });
      expect(result.ok).toBe(true);
      expect(result.message).toContain("HTML report ready");
      expect(result.message).toContain(out);
      expect(result.message).toMatch(/Open this report in your browser now/i);
      expect(result.message).toMatch(/Do not open until the user answers/i);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toContain("<!DOCTYPE html>");
      expect(readFileSync(out, "utf8")).toContain("simple");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
