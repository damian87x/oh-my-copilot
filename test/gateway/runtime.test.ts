import { describe, it, expect } from "vitest";
import {
  runGateway,
  getGatewayStatus,
  selectConnectors,
  parseOnlyFlag,
  waitForSignals,
} from "../../src/gateway/runtime.js";
import type { Connector, ConnectorStatus } from "../../src/gateway/connector.js";

function makeFake(
  name: string,
  opts: { failStart?: string; failStop?: string } = {},
): Connector & { startCalls: number; stopCalls: number } {
  let started = false;
  let lastErr: string | undefined;
  const handle = {
    name,
    startCalls: 0,
    stopCalls: 0,
    async start() {
      this.startCalls++;
      if (opts.failStart) {
        lastErr = opts.failStart;
        throw new Error(opts.failStart);
      }
      started = true;
    },
    async stop() {
      this.stopCalls++;
      if (opts.failStop) throw new Error(opts.failStop);
      started = false;
    },
    status(): ConnectorStatus {
      if (started) return { ready: true };
      if (lastErr) return { ready: false, detail: lastErr };
      return { ready: false, detail: "not started" };
    },
  };
  return handle;
}

describe("parseOnlyFlag", () => {
  it("returns undefined when flag is absent", () => {
    expect(parseOnlyFlag(undefined)).toBeUndefined();
  });
  it("splits, trims, and drops empties", () => {
    expect(parseOnlyFlag("slack, telegram ,, discord")).toEqual(["slack", "telegram", "discord"]);
  });
  it("returns undefined for an empty-but-present value", () => {
    expect(parseOnlyFlag("")).toBeUndefined();
    expect(parseOnlyFlag(" , , ")).toBeUndefined();
  });
});

describe("selectConnectors", () => {
  it("picks factories by name and reports unknowns", () => {
    const reg = {
      a: () => ({ name: "a" }),
      b: () => ({ name: "b" }),
    };
    const r = selectConnectors(reg, ["a", "missing", "b"]);
    expect(r.connectors.map((c) => c.name)).toEqual(["a", "b"]);
    expect(r.unknown).toEqual(["missing"]);
  });
});

describe("getGatewayStatus", () => {
  it("aggregates per-connector status; ready iff all ready", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    await a.start();
    let snap = getGatewayStatus([a, b]);
    expect(snap.ready).toBe(false);
    expect(snap.connectors.map((c) => c.ready)).toEqual([true, false]);
    await b.start();
    snap = getGatewayStatus([a, b]);
    expect(snap.ready).toBe(true);
  });
  it("returns ready=false for an empty set", () => {
    expect(getGatewayStatus([]).ready).toBe(false);
  });
});

describe("runGateway", () => {
  it("starts all connectors in parallel and stops them on shutdown", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    let release: () => void = () => {};
    const shutdown = new Promise<void>((res) => {
      release = res;
    });
    const run = runGateway({
      connectors: [a, b],
      waitForShutdown: () => shutdown,
      log: () => {},
    });
    // Yield so start() promises can settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(a.status().ready).toBe(true);
    expect(b.status().ready).toBe(true);
    release();
    await run;
    expect(a.stopCalls).toBe(1);
    expect(b.stopCalls).toBe(1);
  });

  it("throws when no connectors are provided", async () => {
    await expect(
      runGateway({ connectors: [], waitForShutdown: () => Promise.resolve(), log: () => {} }),
    ).rejects.toThrow(/no connectors/);
  });

  it("continues when one connector's start fails, but throws if ALL fail", async () => {
    const good = makeFake("ok");
    const bad = makeFake("bad", { failStart: "boom" });
    let release: () => void = () => {};
    const shutdown = new Promise<void>((res) => {
      release = res;
    });
    const run = runGateway({
      connectors: [good, bad],
      waitForShutdown: () => shutdown,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(good.status().ready).toBe(true);
    expect(bad.status().ready).toBe(false);
    release();
    await run;
    // stop() called on both, even the one that failed to start.
    expect(good.stopCalls).toBe(1);
    expect(bad.stopCalls).toBe(1);
  });

  it("rejects when every connector's start fails AND still calls stop() on every connector first", async () => {
    const bad1 = makeFake("a", { failStart: "x" });
    const bad2 = makeFake("b", { failStart: "y" });
    await expect(
      runGateway({
        connectors: [bad1, bad2],
        waitForShutdown: () => Promise.resolve(),
        log: () => {},
      }),
    ).rejects.toThrow(/all gateway connectors failed/);
    // Codex finding MAJOR-1: even failed starts may have allocated resources;
    // the runtime must call stop() on every connector before bailing.
    expect(bad1.stopCalls).toBe(1);
    expect(bad2.stopCalls).toBe(1);
  });

  it("still stops connectors when waitForShutdown REJECTS (try/finally)", async () => {
    const c = makeFake("c");
    await expect(
      runGateway({
        connectors: [c],
        waitForShutdown: () => Promise.reject(new Error("wait boom")),
        log: () => {},
      }),
    ).rejects.toThrow(/wait boom/);
    expect(c.stopCalls).toBe(1);
  });

  it("waitForSignals attaches both signal listeners, resolves on signal, and detaches them", async () => {
    type Cb = (sig: NodeJS.Signals) => void;
    const handlers: Record<string, Cb | undefined> = {};
    const offCalls: string[] = [];
    const fakeProc = {
      once(name: string, cb: Cb) {
        handlers[name] = cb;
        return fakeProc as unknown as NodeJS.Process;
      },
      off(name: string, _cb: Cb) {
        offCalls.push(name);
        return fakeProc as unknown as NodeJS.Process;
      },
    };
    const wait = waitForSignals(fakeProc as unknown as NodeJS.Process, () => {});
    expect(handlers["SIGINT"]).toBeTypeOf("function");
    expect(handlers["SIGTERM"]).toBeTypeOf("function");
    handlers["SIGINT"]!("SIGINT" as NodeJS.Signals);
    await wait;
    expect(offCalls.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("survives a connector whose stop() throws", async () => {
    const flaky = makeFake("flaky", { failStop: "stop boom" });
    let release: () => void = () => {};
    const shutdown = new Promise<void>((res) => {
      release = res;
    });
    const run = runGateway({
      connectors: [flaky],
      waitForShutdown: () => shutdown,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await expect(run).resolves.toBeUndefined();
  });
});
