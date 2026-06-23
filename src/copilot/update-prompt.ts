/**
 * Interactive update prompt for the `omp` CLI.
 *
 * Reuses the existing npm-registry check + 6h cache from
 * `scripts/lib/version-check.mjs`. When an update is available and we're
 * attached to a TTY, ask the user whether to self-update and (on yes) run
 * `npm i -g @damian87/omp@latest` for them. Non-TTY / `--json` / CI callers
 * fall back to the passive notice and are never blocked.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ompRoot } from "../omp-root.js";
import { packageRootFromImportMeta } from "../project.js";

const PACKAGE_NAME = "@damian87/omp";
const UPDATE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest`;
const PLUGIN_NAME = "oh-my-copilot";
const PLUGIN_UPDATE_COMMAND = `copilot plugin update ${PLUGIN_NAME}`;

/** Where update-prompt output is sent / input is read. */
export interface UpdatePromptIO {
  print(line: string): void;
  ask(prompt: string): Promise<string | undefined>;
}

interface UpdateInfo {
  current: string;
  latest: string;
}

interface VersionCheckModule {
  checkForUpdate(options?: { stateDir?: string }): Promise<UpdateInfo | null>;
  formatUpdateNotice(current: string, latest: string): string;
}

/** One-line pointer shown to new users alongside updates / on first launch. */
export function gettingStartedHint(): string {
  return "New to omp? Run `omp help` for commands, or `omp` to launch Copilot.";
}

async function loadVersionCheck(importMetaUrl: string): Promise<VersionCheckModule> {
  const url = pathToFileURL(
    join(packageRootFromImportMeta(importMetaUrl), "scripts", "lib", "version-check.mjs"),
  ).href;
  return (await import(url)) as VersionCheckModule;
}

/**
 * Run the global self-update. Returns true on success. `spawnFn` is injectable
 * so tests never shell out to npm.
 */
export async function runSelfUpdate(
  spawnFn?: typeof import("node:child_process").spawn,
): Promise<boolean> {
  const spawn = spawnFn ?? (await import("node:child_process")).spawn;
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn("npm", ["i", "-g", `${PACKAGE_NAME}@latest`], { stdio: "inherit" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Result of refreshing the in-session Copilot plugin. */
export type PluginUpdateStatus = "updated" | "skipped" | "failed";

function runCopilot(
  spawn: typeof import("node:child_process").spawn,
  args: string[],
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    try {
      const child = spawn("copilot", args, { stdio: "inherit" });
      child.on("error", () => resolve(null)); // copilot CLI not installed
      child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Best-effort refresh of the Copilot plugin so the in-session skills/agents/
 * hooks track the same release as the CLI. Refreshes the marketplace catalog,
 * then updates the installed plugin. Returns "skipped" when the copilot CLI
 * isn't available, "failed" on a non-zero plugin update, "updated" otherwise.
 */
export async function updateCopilotPlugin(
  spawnFn?: typeof import("node:child_process").spawn,
): Promise<PluginUpdateStatus> {
  const spawn = spawnFn ?? (await import("node:child_process")).spawn;
  const refreshed = await runCopilot(spawn, ["plugin", "marketplace", "update", PLUGIN_NAME]);
  if (refreshed === null) return "skipped";
  const updated = await runCopilot(spawn, ["plugin", "update", PLUGIN_NAME]);
  if (updated === null) return "skipped";
  return updated === 0 ? "updated" : "failed";
}

function formatPluginStatus(status: PluginUpdateStatus): string {
  switch (status) {
    case "updated":
      return "  Copilot plugin updated.";
    case "failed":
      return `  Copilot plugin update failed; run manually: ${PLUGIN_UPDATE_COMMAND}`;
    case "skipped":
      return "  Copilot plugin: skipped (copilot CLI not found).";
  }
}

export interface MaybePromptUpdateOptions {
  cwd: string;
  io: UpdatePromptIO;
  /** When false, only the passive notice is printed — never prompt. */
  interactive: boolean;
  importMetaUrl?: string;
  /** Test seams. */
  checkForUpdate?: (options: { stateDir: string }) => Promise<UpdateInfo | null>;
  formatUpdateNotice?: (current: string, latest: string) => string;
  runUpdate?: () => Promise<boolean>;
  updatePlugin?: () => Promise<PluginUpdateStatus>;
  env?: NodeJS.ProcessEnv;
}

/** Outcome of an update prompt. `updated` is true only after a successful self-update. */
export interface UpdateOutcome {
  updated: boolean;
}

/**
 * Check for an update and, when interactive and one is available, prompt the
 * user to self-update. No-ops when `OMP_NO_UPDATE_CHECK` is set or no update
 * is available. Returns `{ updated: true }` only when a self-update succeeded,
 * so callers can re-exec into the freshly-installed version.
 */
export async function maybePromptUpdate(options: MaybePromptUpdateOptions): Promise<UpdateOutcome> {
  const env = options.env ?? process.env;
  if (env.OMP_NO_UPDATE_CHECK?.trim()) return { updated: false };

  const stateDir = join(ompRoot(options.cwd), ".omp", "state");

  let checkForUpdate = options.checkForUpdate;
  let formatUpdateNotice = options.formatUpdateNotice;
  if (!checkForUpdate || !formatUpdateNotice) {
    const mod = await loadVersionCheck(options.importMetaUrl ?? import.meta.url);
    checkForUpdate = checkForUpdate ?? mod.checkForUpdate;
    formatUpdateNotice = formatUpdateNotice ?? mod.formatUpdateNotice;
  }

  const update = await checkForUpdate({ stateDir });
  if (!update) return { updated: false };

  options.io.print(formatUpdateNotice(update.current, update.latest));

  if (!options.interactive) return { updated: false };

  const answer = (await options.io.ask("Update now? [y/N] "))?.trim().toLowerCase();
  if (answer === "y" || answer === "yes") {
    const runUpdate = options.runUpdate ?? runSelfUpdate;
    const updatePlugin = options.updatePlugin ?? updateCopilotPlugin;
    options.io.print("Updating omp CLI…");
    const ok = await runUpdate();
    if (!ok) {
      options.io.print(`Update failed; run manually: ${UPDATE_COMMAND}`);
      return { updated: false };
    }
    // Keep the in-session Copilot plugin in lockstep with the CLI.
    options.io.print("Refreshing Copilot plugin…");
    options.io.print(formatPluginStatus(await updatePlugin()));
    options.io.print(`Updated to v${update.latest} — re-run \`omp\`.`);
    return { updated: true };
  }

  options.io.print(gettingStartedHint());
  return { updated: false };
}

export interface MaybeWelcomeOptions {
  cwd: string;
  io: UpdatePromptIO;
  interactive: boolean;
}

/**
 * Print the getting-started hint once on first interactive bare launch, then
 * drop a marker so we stay quiet thereafter. Best-effort — never throws.
 */
export function maybeWelcome(options: MaybeWelcomeOptions): void {
  if (!options.interactive) return;
  const stateDir = join(ompRoot(options.cwd), ".omp", "state");
  const marker = join(stateDir, "welcomed");
  if (existsSync(marker)) return;
  options.io.print(gettingStartedHint());
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
  } catch {
    // best-effort marker write
  }
}
