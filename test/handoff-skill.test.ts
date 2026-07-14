import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const skillPath = path.join(process.cwd(), ".github", "skills", "handoff", "SKILL.md");

describe("handoff skill contract", () => {
  it("exists with matching frontmatter name and /handoff identity", () => {
    expect(existsSync(skillPath)).toBe(true);
    const body = readFileSync(skillPath, "utf8");
    expect(body).toMatch(/^---\nname: handoff\n/m);
    expect(body).toContain("/handoff");
    expect(body).toMatch(/description:/);
  });

  it("routes persistence through omp handoff CLI semantics", () => {
    const body = readFileSync(skillPath, "utf8");
    for (const cmd of [
      "omp handoff create",
      "omp handoff list",
      "omp handoff read",
      "omp handoff close",
    ]) {
      expect(body, `missing ${cmd}`).toContain(cmd);
    }
    // Must not instruct writing files under .omp/handoffs directly as the SoT.
    expect(body).toMatch(/Do not write|never write|not write/i);
    expect(body).toContain(".omp/handoffs");
    // Secrets redaction + references-not-duplication + suggested skills
    expect(body).toMatch(/Redact|secrets/i);
    expect(body).toMatch(/Reference|path or URL/i);
    expect(body).toMatch(/suggested skills|--skill/i);
    // Resume mode
    expect(body).toMatch(/Resume|list open handoffs/i);
  });

  it("does not inject full handoff bodies into copilot-instructions", () => {
    const body = readFileSync(skillPath, "utf8");
    expect(body).toMatch(/never inject full handoff bodies/i);
    expect(body).toContain("copilot-instructions.md");
  });
});
