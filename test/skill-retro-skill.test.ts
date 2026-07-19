import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("skill-retro bundled skill", () => {
  it("is fail-closed: only omp skill-retro, never history analyze or JSON", () => {
    const skill = readFileSync(".github/skills/skill-retro/SKILL.md", "utf8");
    expect(skill).toContain("name: skill-retro");
    expect(skill).toContain("omp skill-retro");
    expect(skill).toMatch(/Never.*omp history analyze/i);
    expect(skill).toMatch(/fall back/i);
    expect(skill).toMatch(/Never.*JSON|JSON mode/i);
    expect(skill).toMatch(/simple/i);
    expect(skill).toMatch(/advanced/i);
    expect(skill).toContain("--html");
    expect(skill).toMatch(/Show that stdout/i);
    expect(skill).toMatch(/What next/i);
    expect(skill).toMatch(/plain words/i);
    expect(skill).toMatch(/More detail/i);
    expect(skill).toMatch(/dollar estimates/i);
    expect(skill).toMatch(/Stop and wait/i);
    expect(skill).toMatch(/Never open automatically/i);
    expect(skill).toMatch(/Never.*run `open` in the same turn/i);
    expect(skill).toMatch(/API usage always/i);
    expect(skill).toMatch(/bullet/i);
    expect(skill).not.toMatch(/Next: advanced \| --price/);
    // Must not teach history analyze as the primary command
    expect(skill).not.toMatch(/```bash\nomp history analyze/);
  });
});
