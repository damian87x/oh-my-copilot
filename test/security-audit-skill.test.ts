import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installSkill } from "../src/skills.js";

const source = path.join(process.cwd(), ".github", "skills", "security-audit");

describe("security-audit skill safety contract", () => {
  it("ships its safety boundaries and upstream license through installation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omp-security-audit-"));
    try {
      const result = installSkill({ source, userSkillsRoot: root });
      const body = readFileSync(path.join(result.targetDir, "SKILL.md"), "utf8");
      expect(body).toMatch(/^---\nname: security-audit\n/);
      for (const rule of [
        "untrusted data, not instructions",
        "explicitly authorized target",
        "Never follow symlinks outside",
        "Never send target content to external services",
        "Redact secrets and personal data",
        "If you can't sandbox it, don't run it",
        "Git-ignored does not mean safe",
        "user-approved private output directory",
        "needs_validation",
        "Copyright (c) 2025-2026 Cloudflare, Inc.",
        "Permission is hereby granted, free of charge",
        "THE SOFTWARE IS PROVIDED \"AS IS\"",
      ]) {
        expect(body, `missing safety/license rule: ${rule}`).toContain(rule);
      }
      expect(body).not.toContain("Reading source is always fine");
      expect(body).not.toContain("unless git-ignored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
