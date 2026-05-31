import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { goalTools } from "../../../src/mcp/tools/goal.js";

const byName = (name: string) => goalTools.find((t) => t.name === name)!;
const cwd = () => mkdtempSync(path.join(tmpdir(), "omc-goal-"));
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("goal tools", () => {
  it("reads a placeholder when no goal is set", () => {
    expect(text(byName("goal_read").handler({ cwd: cwd() }))).toBe("(no repo goal set)");
  });

  it("sets and reads back the repo objective", () => {
    const root = cwd();
    const res = JSON.parse(text(byName("goal_set").handler({ goal: "Be the best", cwd: root })));
    expect(res).toMatchObject({ ok: true, goal: "Be the best" });
    expect(text(byName("goal_read").handler({ cwd: root }))).toBe("Be the best");
    // Stored with our header, so the file is human-readable.
    expect(readFileSync(path.join(root, ".omp", "goal.md"), "utf8")).toBe("# Repo Goal\n\nBe the best\n");
  });

  it("collapses multiline input to a single north-star line", () => {
    const root = cwd();
    byName("goal_set").handler({ goal: "ship\nthe\nthing", cwd: root });
    expect(text(byName("goal_read").handler({ cwd: root }))).toBe("ship the thing");
  });

  it("rejects an empty goal", () => {
    expect(JSON.parse(text(byName("goal_set").handler({ goal: "   ", cwd: cwd() })))).toMatchObject({
      ok: false,
    });
  });

  it("preserves a hand-authored goal that has no Repo Goal header", () => {
    const root = cwd();
    mkdirSync(path.join(root, ".omp"), { recursive: true });
    writeFileSync(path.join(root, ".omp", "goal.md"), "# Ship v1\n", "utf8");
    // The loose `^#.*$` strip used to return "" here, losing the objective.
    expect(text(byName("goal_read").handler({ cwd: root }))).toBe("# Ship v1");
  });
});
