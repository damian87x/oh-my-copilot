import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omc-ho-cli-"));
  writeFileSync(join(root, "package.json"), "{}\n", "utf8");
  return root;
}

describe("omp handoff CLI", () => {
  it("create/list/read/close/archive/prune via --json", async () => {
    const root = tempRoot();
    const create = await runCli([
      "handoff",
      "create",
      "--root",
      root,
      "--json",
      "--objective",
      "CLI handoff",
      "--done",
      "step1",
      "--done",
      "-2 tests still failing",
      "--pending",
      "step2",
      "--next",
      "do step2",
      "--files",
      "src/a.ts",
    ]);
    expect(create.ok).toBe(true);
    const created = create.output as {
      handoff: { id: string; objective: string; done: string[]; generation: { model_calls: number } };
      cost_bearing: boolean;
    };
    expect(created.handoff.objective).toBe("CLI handoff");
    expect(created.handoff.done).toContain("-2 tests still failing");
    expect(created.cost_bearing).toBe(false);
    expect(created.handoff.generation.model_calls).toBe(0);
    expect(typeof (create.output as { path?: string }).path).toBe("string");
    expect((create.output as { path: string }).path).toMatch(/\.md$/);
    expect((create.output as { path: string }).path.startsWith("/")).toBe(true);
    const id = created.handoff.id;

    const list = await runCli(["handoff", "list", "--root", root, "--json"]);
    expect(list.ok).toBe(true);
    expect((list.output as { count: number }).count).toBe(1);

    const read = await runCli(["handoff", "read", id, "--root", root, "--json"]);
    expect(read.ok).toBe(true);
    expect((read.output as { handoff: { pending: string[] } }).handoff.pending).toContain("step2");

    const close = await runCli(["handoff", "close", id, "--promote", "--root", root, "--json"]);
    expect(close.ok).toBe(true);
    expect((close.output as { promote?: { ok: boolean } }).promote?.ok).toBe(true);

    const listAfter = await runCli(["handoff", "list", "--root", root, "--json"]);
    expect((listAfter.output as { count: number }).count).toBe(0);

    const listAll = await runCli(["handoff", "list", "--all", "--root", root, "--json"]);
    expect((listAll.output as { count: number }).count).toBe(1);

    const create2 = await runCli([
      "handoff",
      "create",
      "--root",
      root,
      "--json",
      "--objective",
      "Archive me",
      "--next",
      "x",
    ]);
    expect(create2.ok).toBe(true);
    const id2 = (create2.output as { handoff: { id: string } }).handoff.id;
    const arch = await runCli(["handoff", "archive", id2, "--root", root, "--json"]);
    expect(arch.ok).toBe(true);

    for (const hid of [id, id2]) {
      const p = join(root, ".omp", "handoffs", `${hid}.md`);
      const text = readFileSync(p, "utf8");
      writeFileSync(p, text.replace(/updated_at: "[^"]+"/, 'updated_at: "2000-01-01T00:00:00.000Z"'));
    }

    const prune = await runCli(["handoff", "prune", "--root", root, "--json"]);
    expect(prune.ok).toBe(true);
    expect((prune.output as { removed: string[] }).removed.length).toBe(2);
  });

  it("rejects invalid id with path traversal on read/close/archive", async () => {
    const root = tempRoot();
    for (const cmd of ["read", "close", "archive"] as const) {
      const bad = await runCli(["handoff", cmd, "../etc/passwd", "--root", root, "--json"]);
      expect(bad.ok).toBe(false);
      expect(bad.message ?? "").toMatch(/invalid handoff id/);
    }
  });

  it("--llm without a backend fails honestly (no fake cost)", async () => {
    const root = tempRoot();
    const res = await runCli([
      "handoff",
      "create",
      "--root",
      root,
      "--json",
      "--llm",
      "--objective",
      "please summarize",
    ]);
    expect(res.ok).toBe(false);
    expect(res.message ?? "").toMatch(/not implemented/i);
  });

  it("rejects invalid --state and invalid --older-than-days", async () => {
    const root = tempRoot();
    const badState = await runCli(["handoff", "list", "--root", root, "--json", "--state", "nope"]);
    expect(badState.ok).toBe(false);
    expect(badState.message ?? "").toMatch(/--state/);

    const badPrune = await runCli([
      "handoff",
      "prune",
      "--root",
      root,
      "--json",
      "--older-than-days",
      "",
    ]);
    expect(badPrune.ok).toBe(false);
    expect(badPrune.message ?? "").toMatch(/older-than-days/);
  });

  it("config get exposes handoff-llm; set handoff-llm works", async () => {
    const root = tempRoot();
    const set = await runCli(["config", "set", "handoff-llm", "on", "--root", root, "--json"]);
    expect(set.ok).toBe(true);
    const get = await runCli(["config", "get", "--root", root, "--json"]);
    expect(get.ok).toBe(true);
    expect((get.output as { handoffLlm: string }).handoffLlm).toBe("on");
  });

  it("help mentions handoff commands", async () => {
    const help = await runCli(["help"]);
    expect(help.message ?? "").toContain("handoff create");
    expect(help.message ?? "").toContain("handoff list");
    expect(help.message ?? "").toContain("handoff read");
  });

  it("human create message includes absolute path", async () => {
    const root = tempRoot();
    const res = await runCli([
      "handoff",
      "create",
      "--root",
      root,
      "--objective",
      "path check",
      "--next",
      "go",
    ]);
    expect(res.ok).toBe(true);
    expect(res.message ?? "").toMatch(/path: \//);
    expect(res.message ?? "").toMatch(/\.md/);
  });
});
