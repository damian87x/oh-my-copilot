/**
 * Gateway runtime. Starts a set of {@link Connector}s in parallel, blocks on
 * SIGINT/SIGTERM, then stops them via Promise.allSettled so one failing stop
 * cannot strand the rest.
 *
 * Signal handling is injectable so tests can drive shutdown without sending
 * real signals to the test runner.
 */
import type { Connector, ConnectorStatus } from "./connector.js";

export interface RunGatewayOptions {
  /** Connectors to run. Order is preserved in status output. */
  connectors: Connector[];
  /**
   * Returns a promise that resolves when the runtime should shut down.
   * Default: resolves on SIGINT or SIGTERM.
   */
  waitForShutdown?: () => Promise<void>;
  /** Logger; defaults to console.error so info lines never pollute stdout JSON. */
  log?: (msg: string) => void;
}

export interface GatewayStatusReport {
  ready: boolean;
  connectors: Array<{ name: string } & ConnectorStatus>;
}

/**
 * Compute a status snapshot for a set of connectors. Pure — no I/O. The
 * aggregate `ready` is true only when every connector reports ready.
 */
export function getGatewayStatus(connectors: Connector[]): GatewayStatusReport {
  const rows = connectors.map((c) => {
    const s = c.status();
    return { name: c.name, ready: s.ready, detail: s.detail };
  });
  return { ready: rows.length > 0 && rows.every((r) => r.ready), connectors: rows };
}

/**
 * Resolve on SIGINT/SIGTERM. Exported so it can be tested without sending
 * real signals to the test runner: tests inject a fake `proc` with the same
 * shape as `process` and assert listener attach/detach.
 */
export function waitForSignals(
  proc: Pick<NodeJS.Process, "off" | "once"> = process,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSig = (sig: NodeJS.Signals) => {
      // Detach both listeners so a second signal doesn't double-resolve.
      proc.off("SIGINT", onSig);
      proc.off("SIGTERM", onSig);
      // Log to stderr so JSON consumers on stdout aren't disturbed.
      log(`omp gateway: received ${sig}, shutting down…`);
      resolve();
    };
    proc.once("SIGINT", onSig);
    proc.once("SIGTERM", onSig);
  });
}

/**
 * Run the gateway until shutdown. Returns when all connectors have stopped.
 * Throws if no connectors are provided — callers should fail loudly when their
 * `--only` filter or env config produced an empty set.
 */
export async function runGateway(opts: RunGatewayOptions): Promise<void> {
  const log = opts.log ?? ((m) => console.error(m));
  const connectors = opts.connectors;

  if (connectors.length === 0) {
    throw new Error("no connectors configured — set tokens or pass --only <name>");
  }

  // Start all in parallel; surface per-connector failure but let the rest run.
  // A reasonable default is "best-effort start": if one connector cannot come
  // up, the others continue and `gateway status` reports the failure.
  const startResults = await Promise.allSettled(connectors.map((c) => c.start()));
  startResults.forEach((r, i) => {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      log(`omp gateway: connector "${connectors[i].name}" failed to start: ${msg}`);
    } else {
      log(`omp gateway: connector "${connectors[i].name}" ready`);
    }
  });

  const ready = connectors.filter((_, i) => startResults[i].status === "fulfilled");
  if (ready.length === 0) {
    // Nothing came up. Even failed start()s may have allocated resources, and
    // stop() is required to be idempotent — call it on every connector before
    // surfacing the error, so the runtime upholds its own lifecycle contract.
    await Promise.allSettled(connectors.map((c) => c.stop()));
    throw new Error("all gateway connectors failed to start");
  }

  const wait = opts.waitForShutdown ?? (() => waitForSignals());
  // try/finally guarantees stop() runs even if waitForShutdown rejects (e.g.
  // an injected wait throws, or a signal handler propagates an error).
  try {
    await wait();
  } finally {
    // Stop everything — including connectors that never started, since stop()
    // is required to be idempotent.
    await Promise.allSettled(connectors.map((c) => c.stop()));
  }
}

/**
 * Build a filtered list of connectors from a registry by name. Names not in
 * the registry are reported back so the caller can decide whether to error.
 */
export function selectConnectors<T extends { name: string }>(
  registry: Record<string, () => T>,
  names: string[],
): { connectors: T[]; unknown: string[] } {
  const unknown: string[] = [];
  const connectors: T[] = [];
  for (const name of names) {
    const factory = registry[name];
    if (!factory) {
      unknown.push(name);
      continue;
    }
    connectors.push(factory());
  }
  return { connectors, unknown };
}

/**
 * Parse a comma-separated `--only` value into a list of trimmed, non-empty
 * connector names.
 */
export function parseOnlyFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}
