import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  draftsDir,
  migrateLegacyQuarantine,
  reviewDir,
  selfEvolveDir,
} from "../../src/memory-review/quarantine.js";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-quarantine-"));

function seedLegacy(cwd: string): void {
  const legacyReview = path.join(cwd, ".oh-my-copilot", "memory-review");
  const legacyDrafts = path.join(cwd, ".oh-my-copilot", "self-evolve", "drafts", "deploy-flow");
  mkdirSync(legacyReview, { recursive: true });
  mkdirSync(legacyDrafts, { recursive: true });
  writeFileSync(path.join(legacyReview, "pending-directives.md"), "# Pending directives (review before applying)\n- [ ] legacy rule\n", "utf8");
  writeFileSync(path.join(legacyReview, ".claim-abc"), "2026-01-01T00:00:00.000Z", "utf8");
  writeFileSync(path.join(legacyDrafts, "SKILL.md"), "---\nname: learned-deploy-flow\nstatus: draft\n---\n", "utf8");
  writeFileSync(path.join(cwd, ".oh-my-copilot", "self-evolve", "log.md"), "- legacy correction\n", "utf8");
}

describe("quarantine paths", () => {
  it("resolves under .omp, never .oh-my-copilot", () => {
    const cwd = root();
    expect(reviewDir(cwd)).toBe(path.join(cwd, ".omp", "memory-review"));
    expect(selfEvolveDir(cwd)).toBe(path.join(cwd, ".omp", "self-evolve"));
    expect(draftsDir(cwd)).toBe(path.join(cwd, ".omp", "self-evolve", "drafts"));
  });
});

describe("migrateLegacyQuarantine", () => {
  it("is a no-op when no legacy directory exists", () => {
    const cwd = root();
    migrateLegacyQuarantine(cwd);
    expect(existsSync(path.join(cwd, ".omp", "memory-review"))).toBe(false);
    expect(existsSync(path.join(cwd, ".omp", "self-evolve"))).toBe(false);
  });

  it("moves legacy quarantine content under .omp and removes the emptied legacy dir", () => {
    const cwd = root();
    seedLegacy(cwd);
    migrateLegacyQuarantine(cwd);

    expect(readFileSync(path.join(cwd, ".omp", "memory-review", "pending-directives.md"), "utf8")).toContain("legacy rule");
    expect(existsSync(path.join(cwd, ".omp", "memory-review", ".claim-abc"))).toBe(true);
    expect(readFileSync(path.join(cwd, ".omp", "self-evolve", "drafts", "deploy-flow", "SKILL.md"), "utf8")).toContain("learned-deploy-flow");
    expect(readFileSync(path.join(cwd, ".omp", "self-evolve", "log.md"), "utf8")).toContain("legacy correction");
    expect(existsSync(path.join(cwd, ".oh-my-copilot"))).toBe(false);
  });

  it("is idempotent — running twice changes nothing", () => {
    const cwd = root();
    seedLegacy(cwd);
    migrateLegacyQuarantine(cwd);
    migrateLegacyQuarantine(cwd);
    expect(existsSync(path.join(cwd, ".omp", "memory-review", ".claim-abc"))).toBe(true);
    expect(existsSync(path.join(cwd, ".oh-my-copilot"))).toBe(false);
  });

  it("merges when both legacy and new exist: never overwrites new files, appends pending directives", () => {
    const cwd = root();
    seedLegacy(cwd);
    const newReview = path.join(cwd, ".omp", "memory-review");
    mkdirSync(newReview, { recursive: true });
    writeFileSync(path.join(newReview, "pending-directives.md"), "# Pending directives (review before applying)\n- [ ] new rule\n", "utf8");
    writeFileSync(path.join(newReview, ".claim-abc"), "2026-02-02T00:00:00.000Z", "utf8");

    migrateLegacyQuarantine(cwd);

    const pending = readFileSync(path.join(newReview, "pending-directives.md"), "utf8");
    expect(pending).toContain("- [ ] new rule");
    expect(pending).toContain("- [ ] legacy rule");
    // existing new claim wins over the legacy one
    expect(readFileSync(path.join(newReview, ".claim-abc"), "utf8")).toBe("2026-02-02T00:00:00.000Z");
    // non-conflicting legacy content still moves
    expect(existsSync(path.join(cwd, ".omp", "self-evolve", "drafts", "deploy-flow", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(cwd, ".oh-my-copilot"))).toBe(false);
  });

  it("leaves unrelated files in .oh-my-copilot behind instead of deleting them", () => {
    const cwd = root();
    seedLegacy(cwd);
    writeFileSync(path.join(cwd, ".oh-my-copilot", "user-notes.txt"), "keep me\n", "utf8");
    migrateLegacyQuarantine(cwd);
    expect(readFileSync(path.join(cwd, ".oh-my-copilot", "user-notes.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(path.join(cwd, ".oh-my-copilot", "memory-review"))).toBe(false);
    expect(existsSync(path.join(cwd, ".oh-my-copilot", "self-evolve"))).toBe(false);
  });
});

describe("migrateLegacyQuarantine symlink safety", () => {
  it("leaves a symlinked legacy subtree in place and never moves the link target's content", () => {
    const cwd = root();
    const outside = mkdtempSync(path.join(tmpdir(), "omc-outside-"));
    writeFileSync(path.join(outside, "secret.md"), "do not move me\n", "utf8");
    mkdirSync(path.join(cwd, ".oh-my-copilot"), { recursive: true });
    symlinkSync(outside, path.join(cwd, ".oh-my-copilot", "self-evolve"));

    migrateLegacyQuarantine(cwd);

    expect(readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("do not move me\n");
    expect(existsSync(path.join(cwd, ".omp", "self-evolve"))).toBe(false);
  });
});
