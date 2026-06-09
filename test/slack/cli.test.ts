/**
 * CLI back-compat for `omp slack doctor --json`. Per Codex MAJOR-2, after the
 * gateway refactor we keep emitting the legacy flat JSON shape from the
 * `slack` alias so existing scripts that parse `botToken`/`appToken`/
 * `copilotSession`/`copilotError`/`ready` keep working.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { runCli } from "../../src/cli.js";

const ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "COPILOT_TMUX_SESSION",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("omp slack doctor --json (legacy flat shape)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    // Pin the session env so resolveSession returns a known value without
    // touching tmux on the host. resolveSession accepts an env-pinned value
    // verbatim — see src/comms/resolve-session.ts.
    process.env.COPILOT_TMUX_SESSION = "omp-test-session";
  });
  afterEach(() => restoreEnv(saved));

  it("emits {botToken, appToken, copilotSession, copilotError, ready} when tokens are missing", async () => {
    const r = await runCli(["slack", "doctor", "--json"]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatchObject({
      botToken: false,
      appToken: false,
      ready: false,
      copilotSession: "omp-test-session",
    });
    const out = r.output as Record<string, unknown>;
    // Negative: must NOT use the new gateway-shaped keys.
    expect(out.connectors).toBeUndefined();
    expect(out.warnings).toBeUndefined();
  });

  it("reflects token presence when env vars are set", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-stub";
    process.env.SLACK_APP_TOKEN = "xapp-stub";
    const r = await runCli(["slack", "doctor", "--json"]);
    expect(r.output).toMatchObject({
      botToken: true,
      appToken: true,
      copilotSession: "omp-test-session",
      ready: true,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});

describe("omp gateway status --json (new connector-shaped output)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = snapshotEnv();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    process.env.COPILOT_TMUX_SESSION = "this-session-does-not-exist-omp-test";
  });
  afterEach(() => restoreEnv(saved));

  it("emits {ready, connectors:[...], warnings:[...]}", async () => {
    const r = await runCli(["gateway", "status", "--json"]);
    expect(r.ok).toBe(false);
    const out = r.output as { ready: boolean; connectors: unknown[]; warnings: string[] };
    expect(out.ready).toBe(false);
    expect(Array.isArray(out.connectors)).toBe(true);
    expect(out.connectors.length).toBeGreaterThan(0);
    expect(Array.isArray(out.warnings)).toBe(true);
  });

  it("rejects an unknown connector name in --only with a clear message", async () => {
    const r = await runCli(["gateway", "status", "--only", "telegram", "--json"]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/unknown connector/);
  });
});
