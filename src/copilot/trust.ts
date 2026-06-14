import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Ensure a folder is in Copilot CLI's `trustedFolders` so interactive sessions
 * launched there never block on the "Do you trust the files in this folder?"
 * dialog.
 *
 * Why: `--yolo` / `--allow-all-paths` do NOT suppress the folder-trust dialog in
 * interactive mode — only membership in `~/.copilot/config.json#trustedFolders`
 * does. Without this, `omp` (leader) and every `omp`-launched team worker hang on
 * the trust prompt in any folder the user hasn't manually trusted, which lower-
 * capability models cannot get past on their own. Pre-seeding trust is exactly
 * what picking "remember this folder" does, done up front and unattended.
 *
 * Best-effort and never throws: trust is a convenience, not correctness.
 */
export function copilotConfigPath(): string {
  return join(homedir(), ".copilot", "config.json");
}

// Copilot's config.json is JSONC with a `//` comment header. Strip whole-line
// comments so JSON.parse succeeds (the file uses no inline/trailing comments).
function stripJsoncLineComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

export interface EnsureTrustResult {
  ok: boolean;
  added: boolean;
  folder: string;
  reason?: string;
}

export function ensureFolderTrusted(
  folder: string,
  configPath: string = copilotConfigPath(),
): EnsureTrustResult {
  const resolved = resolve(folder);
  if (process.env.OMP_NO_AUTO_TRUST) {
    return { ok: false, added: false, folder: resolved, reason: "disabled" };
  }
  try {
    if (!existsSync(configPath)) {
      return { ok: false, added: false, folder: resolved, reason: "no-config" };
    }
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(stripJsoncLineComments(raw)) as Record<string, unknown> & {
      trustedFolders?: string[];
    };
    const list = Array.isArray(cfg.trustedFolders) ? cfg.trustedFolders : [];
    if (list.includes(resolved)) {
      return { ok: true, added: false, folder: resolved };
    }
    cfg.trustedFolders = [...list, resolved];
    // Atomic write (temp + rename) so a concurrently-launched worker can never
    // observe a half-written config. Same-folder adds are idempotent, so the
    // last writer always lands a file that contains the folder.
    const tmp = `${configPath}.omp-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    renameSync(tmp, configPath);
    return { ok: true, added: true, folder: resolved };
  } catch (err) {
    return {
      ok: false,
      added: false,
      folder: resolved,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
