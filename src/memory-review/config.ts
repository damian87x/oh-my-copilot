import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

// Memory config resolves with precedence (high -> low):
//   1. OMP_MEMORY_MODE env (mode only)
//   2. project .omp/config.json    (ompRoot(cwd))
//   3. global ~/.omp/config.json   (set once, applies everywhere)
//   4. built-in defaults
// `omp config set` writes the project file by default, or the global file with
// scope "global". Mirrors the ~/.omp/.env home convention (see env/dotenv.ts).

export type MemoryMode = "off" | "on";
export const DEFAULT_REVIEW_MODEL = "gpt-5-mini";
export const DEFAULT_MIN_MESSAGES = 4;

export interface MemoryConfig {
  memoryMode: MemoryMode;
  memoryReviewModel: string;
  memoryReviewMinMessages: number;
}

export type MemoryConfigKey = "memoryMode" | "memoryReviewModel" | "memoryReviewMinMessages";

export interface ReadConfigOptions {
  /** Override the home dir (defaults to os.homedir()); used in tests. */
  homeDir?: string;
}
export interface SetConfigOptions extends ReadConfigOptions {
  /** "project" (default) writes .omp/config.json under ompRoot(cwd); "global"
   *  writes ~/.omp/config.json. */
  scope?: "project" | "global";
}

function projectConfigPath(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "config.json");
}

function globalConfigPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".omp", "config.json");
}

function readRawAt(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readMemoryConfig(cwd: string, opts: ReadConfigOptions = {}): MemoryConfig {
  // Project overrides global, per key.
  const raw = { ...readRawAt(globalConfigPath(opts.homeDir)), ...readRawAt(projectConfigPath(cwd)) };

  const envMode = process.env.OMP_MEMORY_MODE;
  const memoryMode: MemoryMode =
    envMode === "on" || envMode === "off"
      ? envMode
      : raw.memoryMode === "on"
        ? "on"
        : "off";
  const memoryReviewModel =
    typeof raw.memoryReviewModel === "string" && raw.memoryReviewModel.trim()
      ? raw.memoryReviewModel.trim()
      : DEFAULT_REVIEW_MODEL;
  const parsedMin = Number(raw.memoryReviewMinMessages);
  const memoryReviewMinMessages =
    Number.isFinite(parsedMin) && parsedMin >= 0 ? Math.floor(parsedMin) : DEFAULT_MIN_MESSAGES;
  return { memoryMode, memoryReviewModel, memoryReviewMinMessages };
}

/** Persist a single memory key, preserving all other keys in that file. Atomic.
 *  Writes the project file by default, or the global ~/.omp file with scope. */
export function setMemoryConfigValue(
  cwd: string,
  key: MemoryConfigKey,
  value: string,
  opts: SetConfigOptions = {},
): void {
  const p = opts.scope === "global" ? globalConfigPath(opts.homeDir) : projectConfigPath(cwd);
  const raw = readRawAt(p);
  raw[key] = value;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
}
