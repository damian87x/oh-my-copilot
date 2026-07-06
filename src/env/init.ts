/**
 * Interactive setup for `~/.omp/.env`.
 *
 * `omp env init` walks the user through getting their Slack tokens, prompts
 * them, writes the file (chmod 600), and tells them what to run next. Anything
 * that would prompt the user lives behind injectable I/O so unit tests can
 * exercise the full happy path and the validation/abort paths without ever
 * touching a real terminal.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OMP_ENV_DIRNAME, OMP_ENV_FILENAME } from "./dotenv.js";
import { SLACK_ALLOWED_USERS_REQUIRED_MESSAGE } from "../slack/config.js";

/** Where to send instructional and prompt text. */
export interface InitIO {
  /** Display a line to the user (stdout in interactive use). */
  print(line: string): void;
  /** Display a diagnostic warning (stderr — must NEVER pollute stdout when --json is in play). */
  warn?(line: string): void;
  /** Read one line of input (or undefined when stream closed/non-interactive). */
  ask(prompt: string): Promise<string | undefined>;
}

export interface InitOptions {
  io: InitIO;
  /** Override the user's home directory (tests). */
  homeDir?: string;
  /** Use these answers verbatim — skips prompts (`--non-interactive` mode). */
  answers?: Partial<InitAnswers>;
  /** When true, overwrite an existing ~/.omp/.env without asking. */
  force?: boolean;
}

export interface InitAnswers {
  slackBotToken: string;
  slackAppToken: string;
  copilotTmuxSession: string;
  slackAllowedUsers: string;
  /**
   * Default Slack target for `omp gateway notify` and `/slack send`. Channel
   * ID (`C…`/`G…`/`D…`) or user ID (`U…`). Optional — when unset, all notify
   * calls must pass an explicit `--target`.
   */
  slackHomeChannel: string;
}

export interface InitResult {
  /** Whether the file was written. False when the user aborted. */
  ok: boolean;
  /** Resolved file path. */
  path: string;
  /** Reason when ok=false. */
  reason?: string;
}

const BOT_TOKEN_PREFIX = "xoxb-";
const APP_TOKEN_PREFIX = "xapp-";

const SLACK_APP_URL = "https://api.slack.com/apps";

/**
 * Slack app manifest pre-configured for the omp gateway bridge. Includes the
 * bot scopes Slack requires before letting you install the app, plus event
 * subscriptions for DMs and @mentions, plus Socket Mode (no public URL).
 *
 * Keep this in sync with docs/slack-setup.md. If you change one, change both.
 */
export const SLACK_APP_MANIFEST_YAML = `display_information:
  name: omp-copilot
  description: Bridge to a local GitHub Copilot CLI session
features:
  bot_user:
    display_name: omp-copilot
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
`;

const INTRO_LINES = [
  "",
  "omp env init — set up ~/.omp/.env",
  "",
  "This writes your Slack tokens (and optional defaults) to ~/.omp/.env so",
  "`omp gateway serve` works from any shell, without `source .env`.",
  "Shell exports always win, so a one-off override still works.",
  "",
  "──────────────────────────────────────────────────────────────────────",
  "STEP 1 — create the Slack app FROM AN APP MANIFEST (not from scratch).",
  "──────────────────────────────────────────────────────────────────────",
  `  • Open ${SLACK_APP_URL} → "Create New App" → "From an app manifest".`,
  "  • Pick your workspace.",
  `  • Choose YAML and paste the manifest below, then "Create" → "Install to Workspace".`,
  "    (The manifest includes the required scopes so Slack will let you install it.",
  "     Picking 'From scratch' leaves scopes empty — Slack then refuses to install.)",
  "",
  "── manifest (copy from here to the next dashed line) ──",
  ...SLACK_APP_MANIFEST_YAML.trimEnd().split("\n"),
  "── end of manifest ──",
  "",
  "──────────────────────────────────────────────────────────────────────",
  "STEP 2 — grab the two tokens (≈1 min):",
  "──────────────────────────────────────────────────────────────────────",
  `  • Bot token (xoxb-…): "OAuth & Permissions" → "Bot User OAuth Token"`,
  "    (visible after the 'Install to Workspace' step above).",
  `  • App-level token (xapp-…): "Basic Information" → "App-Level Tokens"`,
  "    → Generate, with scope `connections:write`.",
  "",
  "Then paste both tokens at the prompts below. The Slack user allowlist is required;",
  "enter `*` only when every workspace user may reach this Copilot session.",
  "Press ENTER on optional defaults to skip.",
  "",
];

/**
 * Run the interactive setup. Idempotent — re-running shows masked existing
 * values and offers to overwrite (or pass `force: true`).
 *
 * Validation:
 *   - bot token must start with `xoxb-` (we re-prompt up to 2 times)
 *   - app token must start with `xapp-` (we re-prompt up to 2 times)
 *   - empty bot/app token in non-interactive mode is an error
 */
export async function runEnvInit(opts: InitOptions): Promise<InitResult> {
  const { io, force, answers } = opts;
  const home = opts.homeDir ?? homedir();
  const path = join(home, OMP_ENV_DIRNAME, OMP_ENV_FILENAME);

  // Non-interactive path: take everything from `answers`. Used by the CLI
  // when the user passes --bot-token / --app-token flags, or by tests.
  const interactive = !answers;
  if (interactive) {
    for (const line of INTRO_LINES) io.print(line);
  }

  if (existsSync(path) && !force) {
    if (interactive) {
      const existing = readExistingMasked(path);
      io.print(`Existing config at ${path}:`);
      for (const line of existing) io.print(`  ${line}`);
      io.print("");
      const overwrite = await io.ask("Overwrite? [y/N] ");
      if ((overwrite ?? "").trim().toLowerCase() !== "y") {
        return { ok: false, path, reason: "aborted by user (no overwrite)" };
      }
    } else {
      return { ok: false, path, reason: `${path} already exists (use --force to overwrite)` };
    }
  }

  const collected: InitAnswers = {
    slackBotToken: "",
    slackAppToken: "",
    copilotTmuxSession: "",
    slackAllowedUsers: "",
    slackHomeChannel: "",
  };

  if (answers) {
    Object.assign(collected, answers);
  } else {
    collected.slackBotToken = await promptForToken(io, "Slack BOT token", BOT_TOKEN_PREFIX);
    collected.slackAppToken = await promptForToken(io, "Slack APP-LEVEL token", APP_TOKEN_PREFIX);
    collected.copilotTmuxSession = (await io.ask(
      "Pin Copilot tmux session (optional, e.g. omp-9999): ",
    )) ?? "";
    collected.slackAllowedUsers = await promptForRequiredAllowlist(io);
    collected.slackHomeChannel = (await io.ask(
      "Default Slack target for notifications (optional, channel C…/G…/D… or user U…): ",
    )) ?? "";
  }

  // Final validation — in both interactive and non-interactive modes the
  // required tokens must be present and prefix-shaped, otherwise refuse to
  // write a config that wouldn't pass `gateway doctor`.
  const botToken = collected.slackBotToken.trim();
  const appToken = collected.slackAppToken.trim();
  if (!botToken || !botToken.startsWith(BOT_TOKEN_PREFIX)) {
    return {
      ok: false,
      path,
      reason: `Slack BOT token is required and must start with "${BOT_TOKEN_PREFIX}".`,
    };
  }
  if (!appToken || !appToken.startsWith(APP_TOKEN_PREFIX)) {
    return {
      ok: false,
      path,
      reason: `Slack APP-LEVEL token is required and must start with "${APP_TOKEN_PREFIX}".`,
    };
  }

  const session = collected.copilotTmuxSession.trim();
  const users = collected.slackAllowedUsers.trim();
  const homeChannel = collected.slackHomeChannel.trim();
  // Reject allowlists that are non-empty as typed but parse to nothing (e.g. ",,,"
  // or " , "), which would otherwise be written to .env only for loadSlackConfig to
  // reject at gateway start — misleading the operator into thinking access is set up.
  const parsedUsers = users === "*" ? ["*"] : users.split(",").map((s) => s.trim()).filter(Boolean);
  if (parsedUsers.length === 0) {
    return {
      ok: false,
      path,
      reason: SLACK_ALLOWED_USERS_REQUIRED_MESSAGE,
    };
  }

  // Light validation: looksLikeSlackId catches typos before they cause a
  // bewildering BAD_HOME_CHANNEL error at notify-time.
  if (homeChannel) {
    const { looksLikeSlackId } = await import("../gateway/target-parser.js");
    if (!looksLikeSlackId(homeChannel)) {
      return {
        ok: false,
        path,
        reason: `SLACK_HOME_CHANNEL "${homeChannel}" doesn't look like a Slack ID (C…/G…/D…/U… plus 8+ uppercase alphanumeric chars).`,
      };
    }
  }

  const content = renderEnvFile({
    botToken,
    appToken,
    session: session || undefined,
    users,
    homeChannel: homeChannel || undefined,
  });

  mkdirSync(dirname(path), { recursive: true });
  // Atomic, perm-safe write. mkdtempSync creates a brand-new sibling dir with
  // a unique suffix (mode 0o700 on POSIX), so the temp file inside is always
  // freshly created — `{ mode: 0o600 }` is guaranteed to apply, and there's
  // no chance of stomping a pre-existing temp file with stale perms. The
  // final rename then atomically installs the 0o600 file into place.
  let tmpDir: string | null = null;
  let tmpFile: string;
  try {
    tmpDir = mkdtempSync(join(dirname(path), ".env-init-"));
    tmpFile = join(tmpDir, "env");
    writeFileSync(tmpFile, content, { mode: 0o600, encoding: "utf8" });
    // Defense-in-depth: confirm the perms we asked for are what we got
    // before we publish the file. On Windows the check is a no-op.
    if (process.platform !== "win32") {
      const mode = statSync(tmpFile).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(`temp file mode is ${mode.toString(8)}, expected 600`);
      }
    }
    renameSync(tmpFile, path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, path, reason: `failed to write ${path}: ${msg}` };
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // POSIX: file was created with mode 0o600 and that survives the rename.
  // Windows: mode bits are largely meaningless. Either way, we never end up
  // in a state where we'd need to apologize for the perms — if anything went
  // wrong above we'd have returned the error already.
  const lockedDown = process.platform !== "win32";

  if (interactive) {
    io.print("");
    io.print(lockedDown ? `Wrote ${path} (chmod 600).` : `Wrote ${path}.`);
    io.print("");
    io.print("Next:");
    io.print("  1. start a Copilot tmux session if one isn't running already");
    io.print("     (any `omp-<digits>` name; e.g. `tmux new-session -d -s omp-9999`)");
    io.print("  2. `omp gateway status`  — should report ready=true");
    io.print("  3. `omp gateway serve`   — blocks; ^C to stop");
    io.print("");
  }

  return { ok: true, path };
}

interface RenderedKeys {
  botToken: string;
  appToken: string;
  session?: string;
  users: string;
  homeChannel?: string;
}

function renderEnvFile(k: RenderedKeys): string {
  const lines: string[] = [
    "# Written by `omp env init`. Edit by hand or re-run the command.",
    "# Precedence: shell exports always win over values in this file.",
    "",
    `SLACK_BOT_TOKEN=${k.botToken}`,
    `SLACK_APP_TOKEN=${k.appToken}`,
  ];
  if (k.session) lines.push(`COPILOT_TMUX_SESSION=${k.session}`);
  lines.push(`SLACK_ALLOWED_USERS=${k.users}`);
  if (k.homeChannel) lines.push(`SLACK_HOME_CHANNEL=${k.homeChannel}`);
  lines.push("");
  return lines.join("\n");
}

async function promptForRequiredAllowlist(io: InitIO): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = ((await io.ask(
      "Slack user ID allowlist (required, comma-separated, or * to allow all): ",
    )) ?? "").trim();
    if (value) return value;
    io.print(`  ${SLACK_ALLOWED_USERS_REQUIRED_MESSAGE}`);
  }
  return "";
}

async function promptForToken(io: InitIO, label: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = ((await io.ask(`${label} (starts with ${prefix}): `)) ?? "").trim();
    if (value.startsWith(prefix)) return value;
    if (!value) {
      io.print(`  ${label} is required.`);
      continue;
    }
    io.print(`  That doesn't look like a ${label.toLowerCase()} (expected to start with "${prefix}").`);
  }
  // Caller's final validation will reject — we don't throw here so the call
  // site can return a structured error.
  return "";
}

/** Read an existing file and return user-visible lines with values masked. */
function readExistingMasked(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        if (i === -1) return line;
        const key = line.slice(0, i);
        const val = line.slice(i + 1);
        return `${key}=${maskValue(val)}`;
      });
  } catch {
    return ["(could not read existing file)"];
  }
}

function maskValue(v: string): string {
  const trimmed = v.trim();
  if (trimmed.length <= 4) return "****";
  // Show prefix (e.g. xoxb-) + 3 stars + last 4 chars to confirm identity
  // without leaking the bulk of the secret.
  const dashIndex = trimmed.indexOf("-");
  const prefix = dashIndex >= 0 ? trimmed.slice(0, dashIndex + 1) : "";
  const tail = trimmed.slice(-4);
  return `${prefix}***${tail}`;
}
