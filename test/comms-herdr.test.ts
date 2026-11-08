import { afterEach, describe, expect, it, vi } from "vitest";
import { commsRecv, commsSend, commsStatus } from "../src/comms/index.js";
import * as tmuxModule from "../src/team/tmux.js";
import * as herdrModule from "../src/team/herdr.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
import { resolveSession } from "../src/comms/resolve-session.js";
import { makeHerdr } from "../src/team/herdr.js";
import { makeFakeHc } from "./team/fake-hc.js";

function herdrWith(names: string[], screen?: string) {
  const fake = makeFakeHc(screen);
  names.forEach((name, i) => fake.terminals.set(`t${i + 1}`, { name, state: "live" }));
  return { fake, api: makeHerdr({ runner: fake.runner, env: {} }) };
}

describe("omp comms on herdr", () => {
  it("discovers and routes an existing herdr session after switching the default to tmux", async () => {
    const { api } = herdrWith(["omp-42"]);
    vi.stubEnv("OMP_MUX", "tmux");
    vi.spyOn(herdrModule, "makeHerdr").mockReturnValue(api);
    const tmux = { listSessions: () => [], sessionExists: () => false } as unknown as tmuxModule.TmuxApi;
    vi.spyOn(tmuxModule, "makeTmux").mockReturnValue(tmux);
    expect(resolveSession()).toEqual({ ok: true, session: "omp-42", source: "discovery" });
    expect(await commsStatus("omp-42", { isOnline: async () => true })).toMatchObject({ exists: true });
    expect(await commsSend("omp-42", "hello", { isOnline: async () => true })).toMatchObject({ ok: true, submitted: true });
    expect(await commsRecv("omp-42")).toMatchObject({ ok: true });
  });

  it("refuses to discover silently when both backends have launcher sessions", () => {
    const { api } = herdrWith(["omp-42"]);
    vi.stubEnv("OMP_MUX", "tmux");
    vi.spyOn(herdrModule, "makeHerdr").mockReturnValue(api);
    vi.spyOn(tmuxModule, "makeTmux").mockReturnValue({ listSessions: () => ["omp-43"] } as unknown as tmuxModule.TmuxApi);
    expect(resolveSession()).toMatchObject({ ok: false, candidates: ["omp-43", "omp-42"] });
  });
  it("discovers exactly one launcher terminal (omp-<digits>)", () => {
    const { api } = herdrWith(["omp-1793739514795", "build"]);
    expect(resolveSession({ tmux: api })).toEqual({ ok: true, session: "omp-1793739514795", source: "discovery" });
  });

  it("never mistakes a team worker (omp-<hash6>-wN, even all-digit hash) for a Copilot session", () => {
    const { api } = herdrWith(["omp-123456-w1", "omp-123456-w2"]);
    const r = resolveSession({ tmux: api });
    expect(r.ok).toBe(false);
  });

  it("refuses to pick between several sessions", () => {
    const { api } = herdrWith(["omp-1", "omp-2"]);
    expect(resolveSession({ tmux: api })).toMatchObject({ ok: false, candidates: ["omp-1", "omp-2"] });
  });

  it("send submits once via hc send; recv reads the terminal", async () => {
    const { fake, api } = herdrWith(["omp-42"], "● answer: 4\n❯ \n / commands · ? help\n");
    const sent = await commsSend("omp-42", "what is 2+2", { tmux: api, isOnline: async () => true });
    expect(sent).toMatchObject({ ok: true, submitted: true });
    expect(fake.sends).toEqual([{ target: "omp-42", text: "what is 2+2" }]);
    const recv = await commsRecv("omp-42", { tmux: api });
    expect(recv).toMatchObject({ ok: true });
    expect(JSON.stringify(recv)).toContain("answer: 4");
  });

  it("send on a missing session fails without touching hc send", async () => {
    const { fake, api } = herdrWith([]);
    const sent = await commsSend("omp-42", "hi", { tmux: api, isOnline: async () => true });
    expect(sent).toMatchObject({ ok: false, error: expect.stringMatching(/not running/) });
    expect(fake.sends).toEqual([]);
  });
});
