import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countPendingDirectives, pendingDirectivesNudge } from "../../scripts/lib/pending-directives.mjs";

const root = () => mkdtempSync(path.join(tmpdir(), "omc-pend-"));

function writePending(cwd: string, body: string, dirname = ".omp") {
  const dir = path.join(cwd, dirname, "memory-review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "pending-directives.md"), body, "utf8");
}

describe("countPendingDirectives", () => {
  it("counts only unchecked items", () => {
    const cwd = root();
    writePending(cwd, "# Pending\n- [ ] one\n- [x] already promoted\n- [ ] two\n");
    expect(countPendingDirectives(cwd)).toBe(2);
  });

  it("returns 0 when the file is absent", () => {
    expect(countPendingDirectives(root())).toBe(0);
  });

  it("falls back to the legacy .oh-my-copilot queue before migration", () => {
    const cwd = root();
    writePending(cwd, "- [ ] legacy one\n", ".oh-my-copilot");
    expect(countPendingDirectives(cwd)).toBe(1);
  });
});

describe("pendingDirectivesNudge", () => {
  it("produces a nudge string when there are pending items", () => {
    const cwd = root();
    writePending(cwd, "- [ ] one\n- [ ] two\n");
    const nudge = pendingDirectivesNudge(cwd);
    expect(nudge).toContain("2");
    expect(nudge.toLowerCase()).toContain("review");
    expect(nudge).toContain("omp project-memory pending");
    expect(nudge).toContain("promote-directive");
    expect(nudge).toContain("dismiss-directive");
  });

  it("returns empty string when nothing is pending", () => {
    expect(pendingDirectivesNudge(root())).toBe("");
  });
});
