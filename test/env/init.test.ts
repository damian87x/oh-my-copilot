import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnvInit, SLACK_APP_MANIFEST_YAML, type InitIO } from "../../src/env/init.js";
import { OMP_ENV_DIRNAME, OMP_ENV_FILENAME } from "../../src/env/dotenv.js";

function makeScripted(answers: (string | undefined)[]): { io: InitIO; output: string[]; remaining: () => number } {
  const output: string[] = [];
  let i = 0;
  return {
    output,
    remaining: () => answers.length - i,
    io: {
      print: (line) => output.push(line),
      ask: async () => answers[i++],
    },
  };
}

describe("runEnvInit (non-interactive / answers path)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omp-init-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes ~/.omp/.env with the supplied tokens (chmod 600 best-effort)", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: {
        slackBotToken: "xoxb-abc",
        slackAppToken: "xapp-def",
        copilotTmuxSession: "",
        slackAllowedUsers: "*",
      },
    });
    expect(r.ok).toBe(true);
    const path = join(home, OMP_ENV_DIRNAME, OMP_ENV_FILENAME);
    expect(r.path).toBe(path);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/^SLACK_BOT_TOKEN=xoxb-abc$/m);
    expect(text).toMatch(/^SLACK_APP_TOKEN=xapp-def$/m);
    expect(text).not.toMatch(/COPILOT_TMUX_SESSION=/);
    expect(text).toMatch(/^SLACK_ALLOWED_USERS=\*$/m);
    // POSIX must lock the secret file to 0o600 from the moment it exists —
    // we create through an atomic temp file with mode 0o600, then rename.
    // We only relax on Windows, where mode bits are largely meaningless.
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("write is atomic via a unique temp dir — no `.env-init-*` siblings left behind", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r.ok).toBe(true);
    const dir = join(home, OMP_ENV_DIRNAME);
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(dir);
    expect(entries).toEqual([OMP_ENV_FILENAME]);
    expect(entries.some((e: string) => e.startsWith(".env-init-"))).toBe(false);
  });

  it("a pre-existing permissive `.tmp` sibling can't poison the final file's mode", async () => {
    if (process.platform === "win32") return; // mode bits meaningless on Windows
    // Drop a deliberately-permissive file at what an older implementation
    // would have used as its deterministic temp path. The new mkdtempSync-
    // based code path picks a fresh random sibling each time, so this stale
    // file must not influence the final ~/.omp/.env mode.
    const dir = join(home, OMP_ENV_DIRNAME);
    const { mkdirSync, writeFileSync: write } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const stalePath = join(dir, `.env.tmp.${process.pid}`);
    write(stalePath, "STALE=stale\n", { mode: 0o644 });

    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r.ok).toBe(true);
    const finalPath = join(dir, OMP_ENV_FILENAME);
    // And the file content is the freshly written one, not the stale temp.
    const finalText = readFileSync(finalPath, "utf8");
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
    expect(finalText).toMatch(/xoxb-a/);
    expect(finalText).not.toMatch(/STALE/);
  });

  it("writes optional COPILOT_TMUX_SESSION / SLACK_ALLOWED_USERS when provided", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: {
        slackBotToken: "xoxb-abc",
        slackAppToken: "xapp-def",
        copilotTmuxSession: "omp-1234",
        slackAllowedUsers: "U1,U2",
      },
    });
    expect(r.ok).toBe(true);
    const text = readFileSync(r.path, "utf8");
    expect(text).toMatch(/^COPILOT_TMUX_SESSION=omp-1234$/m);
    expect(text).toMatch(/^SLACK_ALLOWED_USERS=U1,U2$/m);
  });

  it("rejects when bot token is missing or wrong prefix", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r1 = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "", slackAppToken: "xapp-x", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/BOT token/);
    const r2 = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "wrong", slackAppToken: "xapp-x", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/BOT token/);
  });

  it("rejects when app token is missing or wrong prefix", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-x", slackAppToken: "nope", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/APP-LEVEL token/);
  });

  it("rejects when SLACK_ALLOWED_USERS is missing", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const r = await runEnvInit({
      io,
      homeDir: home,
      answers: {
        slackBotToken: "xoxb-x",
        slackAppToken: "xapp-x",
        copilotTmuxSession: "",
        slackAllowedUsers: "",
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SLACK_ALLOWED_USERS=.*\*/);
  });

  it("rejects a semantically-empty SLACK_ALLOWED_USERS that parses to nothing", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    for (const allow of [",,,", " , "]) {
      const r = await runEnvInit({
        io,
        homeDir: home,
        answers: {
          slackBotToken: "xoxb-x",
          slackAppToken: "xapp-x",
          copilotTmuxSession: "",
          slackAllowedUsers: allow,
        },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/SLACK_ALLOWED_USERS=.*\*/);
    }
  });

  it("non-interactive: refuses to overwrite an existing file without --force", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    const first = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(first.ok).toBe(true);
    const second = await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-b", slackAppToken: "xapp-b", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already exists/);
    const text = readFileSync(first.path, "utf8");
    expect(text).toMatch(/xoxb-a/);
  });

  it("non-interactive: --force overwrites existing file", async () => {
    const io: InitIO = { print: () => {}, ask: async () => undefined };
    await runEnvInit({
      io,
      homeDir: home,
      answers: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    const r = await runEnvInit({
      io,
      homeDir: home,
      force: true,
      answers: { slackBotToken: "xoxb-b", slackAppToken: "xapp-b", copilotTmuxSession: "", slackAllowedUsers: "*" },
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(r.path, "utf8")).toMatch(/xoxb-b/);
  });
});

describe("runEnvInit (interactive / scripted IO)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omp-init-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("happy path: prompts for tokens, skips optionals, writes the file", async () => {
    // 5 answers: bot, app, session(skip), users(* allow-all), home target(skip)
    const { io, output } = makeScripted(["xoxb-bot", "xapp-app", "", "*", ""]);
    const r = await runEnvInit({ io, homeDir: home });
    expect(r.ok).toBe(true);
    const text = readFileSync(r.path, "utf8");
    expect(text).toMatch(/SLACK_BOT_TOKEN=xoxb-bot/);
    expect(text).toMatch(/SLACK_APP_TOKEN=xapp-app/);
    expect(text).toMatch(/^SLACK_ALLOWED_USERS=\*$/m);
    // Intro printed where-to-get-tokens guidance
    const printed = output.join("\n");
    expect(printed).toContain("api.slack.com/apps");
    expect(printed).toMatch(/Bot User OAuth Token|xoxb/);
    expect(printed).toMatch(/connections:write/);
    // Next-steps printed
    expect(printed).toMatch(/gateway status/);
    expect(printed).toMatch(/gateway serve/);
  });

  it("prints the Slack app manifest YAML so the user can paste it (with required scopes)", async () => {
    const { io, output } = makeScripted(["xoxb-bot", "xapp-app", "", "*", ""]);
    await runEnvInit({ io, homeDir: home });
    const printed = output.join("\n");
    // Steers the user away from 'From scratch' (which is what triggers Slack's
    // 'add at least one feature or permission scope' error).
    expect(printed).toMatch(/From an app manifest/);
    expect(printed).not.toMatch(/From scratch.*recommended/i);
    // Manifest body present verbatim so users can copy-paste into the dialog.
    for (const line of SLACK_APP_MANIFEST_YAML.trimEnd().split("\n")) {
      expect(printed).toContain(line);
    }
    // The required bot scopes are in the manifest — explicit asserts so a
    // future edit that drops one fails this test loudly.
    expect(printed).toMatch(/app_mentions:read/);
    expect(printed).toMatch(/chat:write/);
    expect(printed).toMatch(/im:history/);
    expect(printed).toMatch(/im:read/);
    expect(printed).toMatch(/im:write/);
    expect(printed).toMatch(/socket_mode_enabled: true/);
  });

  it("re-prompts when the user mistypes the bot-token prefix", async () => {
    const { io } = makeScripted(["bad-token", "xoxb-good", "xapp-good", "", "*", ""]);
    const r = await runEnvInit({ io, homeDir: home });
    expect(r.ok).toBe(true);
    expect(readFileSync(r.path, "utf8")).toMatch(/xoxb-good/);
  });

  it("re-prompts when the required Slack allowlist is blank", async () => {
    const { io, output } = makeScripted(["xoxb-bot", "xapp-app", "", "", "*", ""]);
    const r = await runEnvInit({ io, homeDir: home });
    expect(r.ok).toBe(true);
    expect(readFileSync(r.path, "utf8")).toMatch(/^SLACK_ALLOWED_USERS=\*$/m);
    expect(output.join("\n")).toMatch(/SLACK_ALLOWED_USERS/);
  });

  it("interactive overwrite prompt: 'n' aborts and preserves the file", async () => {
    // First write
    await runEnvInit({
      io: { print: () => {}, ask: async () => undefined },
      homeDir: home,
      answers: {
        slackBotToken: "xoxb-original",
        slackAppToken: "xapp-original",
        copilotTmuxSession: "",
        slackAllowedUsers: "*",
      },
    });
    // Second pass, user declines overwrite
    const { io } = makeScripted(["n"]);
    const r = await runEnvInit({ io, homeDir: home });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/aborted/);
    expect(readFileSync(r.path, "utf8")).toMatch(/xoxb-original/);
  });

  it("masks existing token values when showing them at the overwrite prompt", async () => {
    await runEnvInit({
      io: { print: () => {}, ask: async () => undefined },
      homeDir: home,
      answers: {
        slackBotToken: "xoxb-supersecretvalue1234",
        slackAppToken: "xapp-anothersecret9876",
        copilotTmuxSession: "",
        slackAllowedUsers: "*",
      },
    });
    const { io, output } = makeScripted(["n"]);
    await runEnvInit({ io, homeDir: home });
    const printed = output.join("\n");
    // Raw secret values should NOT appear in the prompt UI.
    expect(printed).not.toContain("xoxb-supersecretvalue1234");
    expect(printed).not.toContain("xapp-anothersecret9876");
    // Last 4 chars should appear (mask confirms identity).
    expect(printed).toMatch(/1234/);
    expect(printed).toMatch(/9876/);
  });
});
