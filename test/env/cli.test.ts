/**
 * CLI-surface tests for `omp env init` — exercises handleEnvCommand and the
 * runCli routing layer (TTY detection, env-var precedence over flags, JSON
 * output, secret-leak warning). The deep init logic lives in init.test.ts.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli.js";

const ENV_KEYS = [
  "HOME",
  "OMP_INIT_BOT_TOKEN",
  "OMP_INIT_APP_TOKEN",
  "OMP_INIT_SESSION",
  "OMP_INIT_USERS",
  "OMP_INIT_NO_WARN",
] as const;

function snap(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restore(s: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

describe("omp env init (runCli surface)", () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = snap();
    home = mkdtempSync(join(tmpdir(), "omp-cli-env-"));
    process.env.HOME = home;
    delete process.env.OMP_INIT_BOT_TOKEN;
    delete process.env.OMP_INIT_APP_TOKEN;
    delete process.env.OMP_INIT_SESSION;
    delete process.env.OMP_INIT_USERS;
    delete process.env.OMP_INIT_NO_WARN;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    restore(saved);
  });

  it("writes the env file in non-interactive mode via env vars; --json reports ok+path", async () => {
    process.env.OMP_INIT_BOT_TOKEN = "xoxb-env-bot";
    process.env.OMP_INIT_APP_TOKEN = "xapp-env-app";
    const r = await runCli(["env", "init", "--json"]);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    const path = join(home, ".omp", ".env");
    expect((r.output as { ok: boolean; path: string }).path).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/SLACK_BOT_TOKEN=xoxb-env-bot/);
    // No warning emitted when using env vars (the safe path).
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("warning:"))).toBe(false);
  });

  it("warns on stderr when secrets are passed via --bot-token/--app-token flags", async () => {
    const r = await runCli([
      "env",
      "init",
      "--bot-token",
      "xoxb-flag-bot",
      "--app-token",
      "xapp-flag-app",
    ]);
    expect(r.ok).toBe(true);
    const warned = errSpy.mock.calls.some((c) =>
      String(c[0]).includes("--bot-token/--app-token leak"),
    );
    expect(warned).toBe(true);
  });

  it("OMP_INIT_NO_WARN=1 silences the flag-leak warning", async () => {
    process.env.OMP_INIT_NO_WARN = "1";
    await runCli(["env", "init", "--bot-token", "xoxb-a", "--app-token", "xapp-a"]);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("warning:"))).toBe(false);
  });

  it("env vars take precedence over flags when both are present", async () => {
    process.env.OMP_INIT_BOT_TOKEN = "xoxb-from-env";
    process.env.OMP_INIT_APP_TOKEN = "xapp-from-env";
    await runCli([
      "env",
      "init",
      "--bot-token",
      "xoxb-from-flag",
      "--app-token",
      "xapp-from-flag",
    ]);
    const text = readFileSync(join(home, ".omp", ".env"), "utf8");
    expect(text).toMatch(/SLACK_BOT_TOKEN=xoxb-from-env/);
    expect(text).not.toMatch(/xoxb-from-flag/);
  });

  it("rejects with exit 1 + reason when bot token has the wrong prefix", async () => {
    process.env.OMP_INIT_BOT_TOKEN = "not-a-token";
    process.env.OMP_INIT_APP_TOKEN = "xapp-ok";
    const r = await runCli(["env", "init", "--json"]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect((r.output as { reason: string }).reason).toMatch(/BOT token/);
  });

  it("refuses to overwrite without --force; --force succeeds", async () => {
    process.env.OMP_INIT_BOT_TOKEN = "xoxb-1";
    process.env.OMP_INIT_APP_TOKEN = "xapp-1";
    expect((await runCli(["env", "init", "--json"])).ok).toBe(true);
    process.env.OMP_INIT_BOT_TOKEN = "xoxb-2";
    const r2 = await runCli(["env", "init", "--json"]);
    expect(r2.ok).toBe(false);
    expect((r2.output as { reason: string }).reason).toMatch(/already exists/);
    const r3 = await runCli(["env", "init", "--force", "--json"]);
    expect(r3.ok).toBe(true);
    expect(readFileSync(join(home, ".omp", ".env"), "utf8")).toMatch(/xoxb-2/);
  });

  it("--json mode keeps stdout pure (the secret-leak warning lands on stderr)", async () => {
    // Using --bot-token/--app-token flags emits the secret-leak warning.
    // The warning MUST land on stderr; stdout MUST contain only valid JSON.
    // (Intro banner is only printed in interactive mode, so it's not part
    // of this scenario — the warning alone suffices to prove the channel.)
    const r = await runCli([
      "env",
      "init",
      "--json",
      "--bot-token",
      "xoxb-stdout-test",
      "--app-token",
      "xapp-stdout-test",
    ]);
    expect(r.ok).toBe(true);
    // The CLI emits the JSON itself via printResult (not via console.log inside
    // the command), so we verify nothing the command produced reached stdout.
    expect(logSpy.mock.calls.length).toBe(0);
    // The warning landed on stderr.
    const warned = errSpy.mock.calls.some((c) => String(c[0]).includes("--bot-token/--app-token leak"));
    expect(warned).toBe(true);
  });

  it("unknown subcommand returns clear usage", async () => {
    const r = await runCli(["env", "bogus"]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/Unknown env subcommand/);
  });
});
