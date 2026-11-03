import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hcGroupName,
  hcKeyName,
  hcWorkerName,
  lastLines,
  makeHerdr,
  validHcName,
  type HcResult,
} from "../../src/team/herdr.js";
import { sendToWorker } from "../../src/team/tmux.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reply = HcResult | ((args: string[]) => HcResult);
function ok(stdout = ""): HcResult {
  return { stdout, stderr: "", status: 0 };
}
function err(kind: string, status = 1): HcResult {
  return { stdout: "", stderr: JSON.stringify({ error: { kind, message: kind } }), status };
}
const timeout: HcResult = { stdout: "", stderr: "ETIMEDOUT", status: 1, timedOut: true };

function fakeHc(replies: Record<string, Reply[] | Reply>) {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const queues = new Map(Object.entries(replies).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const runner = (args: string[], timeoutMs: number): HcResult => {
    calls.push({ args, timeoutMs });
    const q = queues.get(args[0]!);
    const next = q && (q.length > 1 ? q.shift()! : q[0]!);
    if (!next) return ok();
    return typeof next === "function" ? next(args) : next;
  };
  return { runner, calls };
}

function binDir(): { dir: string; bin: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "omp-herdr-"));
  dirs.push(dir);
  const bin = path.join(dir, "omp");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

describe("hc naming", () => {
  it("groups are deterministic, short, lowercase", () => {
    const g = hcGroupName("My Team With A Very Long Name That Exceeds Limits");
    expect(g).toMatch(/^omp-[0-9a-f]{6}$/);
    expect(hcGroupName("x")).toBe(hcGroupName("x"));
    expect(hcWorkerName(g, 12)).toBe(`${g}-w12`);
    expect(validHcName(hcWorkerName(g, 99))).toBe(true);
  });

  it("validHcName follows hc's rule", () => {
    expect(validHcName("a.b")).toBe(true);
    expect(validHcName("omp-abc123-w1")).toBe(true);
    expect(validHcName("Abc")).toBe(false);
    expect(validHcName("t7")).toBe(false);
    expect(validHcName("t1b")).toBe(false);
    expect(validHcName("x".repeat(33))).toBe(false);
  });

  it("maps tmux key names", () => {
    expect(hcKeyName("C-m")).toBe("enter");
    expect(hcKeyName("Enter")).toBe("enter");
    expect(hcKeyName("C-u")).toBe("ctrl+u");
    expect(hcKeyName("Escape")).toBe("esc");
  });

  it("lastLines trims trailing blank screen rows", () => {
    expect(lastLines("a\nb\nc\n\n\n   \n", 2)).toBe("b\nc\n");
  });
});

describe("makeHerdr", () => {
  it("spawnWorker: env-file launcher, absolute bin, flags, no secrets in argv", () => {
    const { dir, bin } = binDir();
    const { runner, calls } = fakeHc({ run: ok('{"address":"t4","name":"omp-abc123-w1","state":"live"}') });
    const api = makeHerdr({ runner, env: { PATH: dir, GH_TOKEN: "ghp_secret", COPILOT_KEY: "byok" }, envDir: path.join(dir, "env") });
    const r = api.spawnWorker({
      name: "omp-abc123-w1",
      cwd: "/repo",
      argv: ["omp", "--madmax"],
      labels: { "omp.team": "x" },
      extraEnv: { OMP_TEAM_WORKER: "1" },
    });
    expect(r).toEqual({ ok: true, address: "t4", name: "omp-abc123-w1" });
    expect(calls[0]!.args.slice(0, 2)).toEqual(["server", "status"]);
    const run = calls[1]!;
    expect(run.timeoutMs).toBe(30_000);
    expect(run.args.slice(0, 7)).toEqual(["run", "--bg", "--json", "--name", "omp-abc123-w1", "--cwd", "/repo"]);
    expect(run.args).toEqual(expect.arrayContaining(["--label", "omp.team=x", "--no-notify", "--outlive-parent", "--no-parent"]));
    const tail = run.args.slice(run.args.indexOf("--") + 1);
    expect(tail[0]).toBe("/bin/sh");
    expect(tail.slice(-2)).toEqual([bin, "--madmax"]);
    expect(run.args.join(" ")).not.toContain("ghp_secret");
    expect(run.args.join(" ")).not.toContain("byok");
  });

  it("spawnWorker keeps the parent link only when asked, and warms up once", () => {
    const { dir } = binDir();
    const { runner, calls } = fakeHc({ run: ok('{"address":"t5"}') });
    const api = makeHerdr({ runner, env: { PATH: dir }, envDir: path.join(dir, "env") });
    api.spawnWorker({ name: "omp-abc123-w1", cwd: "/r", argv: ["omp"], keepParent: true });
    api.spawnWorker({ name: "omp-abc123-w2", cwd: "/r", argv: ["omp"] });
    expect(calls.filter((c) => c.args[0] === "server")).toHaveLength(1);
    const runs = calls.filter((c) => c.args[0] === "run");
    expect(runs[0]!.args).not.toContain("--no-parent");
    expect(runs[1]!.args).toContain("--no-parent");
  });

  it("spawnWorker surfaces name_taken, invalid names and missing binaries", () => {
    const { dir } = binDir();
    const { runner } = fakeHc({ run: err("name_taken") });
    const api = makeHerdr({ runner, env: { PATH: dir }, envDir: path.join(dir, "env") });
    expect(api.spawnWorker({ name: "omp-abc123-w1", cwd: "/r", argv: ["omp"] })).toEqual({ ok: false, error: expect.stringMatching(/name_taken/) });
    expect(api.spawnWorker({ name: "Bad", cwd: "/r", argv: ["omp"] })).toEqual({ ok: false, error: expect.stringMatching(/invalid hc terminal name/) });
    expect(api.spawnWorker({ name: "omp-abc123-w2", cwd: "/r", argv: ["nope-cmd"] })).toEqual({ ok: false, error: expect.stringMatching(/not found/) });
  });

  it("alive/paneDead: finished or not_found ⇒ dead; timeout or core down ⇒ unknown, never dead", () => {
    const { runner } = fakeHc({
      get: [ok('{"state":"live"}'), ok('{"state":"finished"}'), err("not_found", 3), timeout, err("connect_failed")],
    });
    const api = makeHerdr({ runner, env: {} });
    expect(api.alive("t1")).toBe("alive");
    expect(api.alive("t1")).toBe("dead");
    expect(api.paneDead("t1")).toBe(true);
    expect(api.alive("t1")).toBe("unknown");
    expect(api.paneDead("t1")).toBe(false);
  });

  it("capturePane returns only the last N lines", () => {
    const screen = `${Array.from({ length: 130 }, (_, i) => `row${i}`).join("\n")}\n\n\n`;
    const { runner, calls } = fakeHc({ read: ok(screen) });
    const out = makeHerdr({ runner, env: {} }).capturePane("t1", 3).stdout;
    expect(out).toBe("row127\nrow128\nrow129\n");
    expect(calls[0]!.args).toEqual(["read", "t1", "--lines", "3"]);
  });

  it("submit sends once; a timeout is never followed by a resend", async () => {
    const { runner, calls } = fakeHc({ send: timeout });
    const api = makeHerdr({ runner, env: {} });
    expect(await api.submit("t1", "do the thing")).toBe(false);
    expect(calls.filter((c) => c.args[0] === "send")).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === "keys")).toHaveLength(0);
    expect(calls[0]!.timeoutMs).toBe(200_000);
  });

  it("submit treats blocked (exit 9) as not sent, without retry", async () => {
    const { runner, calls } = fakeHc({ send: err("blocked", 9) });
    expect(await makeHerdr({ runner, env: {} }).submit("t1", "x")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("submit presses Enter once only when the text is provably still on the input line", async () => {
    const { runner, calls } = fakeHc({ send: ok("{}"), read: ok("● earlier\n❯ please review the diff now\n") });
    expect(await makeHerdr({ runner, env: {} }).submit("t1", "please review the diff now")).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["send", "read", "keys"]);
    expect(calls[2]!.args).toEqual(["keys", "t1", "enter", "--json"]);
  });

  it("submit does not press Enter when the prompt left the input line", async () => {
    const { runner, calls } = fakeHc({ send: ok("{}"), read: ok("❯ please review\n● Working\n❯ \n") });
    expect(await makeHerdr({ runner, env: {} }).submit("t1", "please review")).toBe(true);
    expect(calls.map((c) => c.args[0])).toEqual(["send", "read"]);
  });

  it("sendToWorker routes through the native submit on herdr", async () => {
    const { runner, calls } = fakeHc({ send: ok("{}"), read: ok("❯ \n") });
    expect(await sendToWorker(makeHerdr({ runner, env: {} }), "t2", "hello")).toBe(true);
    expect(calls[0]!.args).toEqual(["send", "t2", "hello", "--json"]);
  });

  it("closeGroup kills and removes exactly the group's live terminals", () => {
    const { runner, calls } = fakeHc({
      ls: ok(JSON.stringify({ terminals: [
        { address: "t1", name: "omp-abc123-w1" },
        { address: "t2", name: "omp-abc123-w2" },
        { address: "t3", name: "omp-zzz999-w1" },
        { address: "t4" },
      ] })),
    });
    const api = makeHerdr({ runner, env: {} });
    expect(api.closeGroup("omp-abc123")).toBe(2);
    expect(calls.filter((c) => c.args[0] === "kill").map((c) => c.args[1])).toEqual(["t1", "t2"]);
    expect(calls.filter((c) => c.args[0] === "rm").map((c) => c.args[1])).toEqual(["t1", "t2"]);
    expect(api.sessionExists("omp-abc123")).toBe(true);
    expect(api.sessionExists("omp-nope00")).toBe(false);
    expect(api.listSessions()).toEqual(["omp-abc123-w1", "omp-abc123-w2", "omp-zzz999-w1"]);
  });

  it("tmux-only operations fail loudly instead of guessing", () => {
    const api = makeHerdr({ runner: fakeHc({}).runner, env: {} });
    expect(api.newSession("s", "/").status).toBe(1);
    expect(api.splitWindow("s", "/").status).toBe(1);
    expect(api.sendText("t1", "x").stderr).toMatch(/not supported on herdr/);
  });
});

describe("makeHerdr without hc installed", () => {
  it("degrades per call instead of throwing", async () => {
    const api = makeHerdr({ env: { PATH: "/nonexistent" } });
    expect(api.alive("t1")).toBe("unknown");
    expect(api.paneDead("t1")).toBe(false);
    expect(api.capturePane("t1").status).toBe(127);
    expect(await api.submit("t1", "x")).toBe(false);
    expect(api.spawnWorker({ name: "omp-abc123-w1", cwd: "/", argv: ["/bin/sh"] })).toEqual({ ok: false, error: expect.stringMatching(/hc \(herdr-core\) not found/) });
  });
});
