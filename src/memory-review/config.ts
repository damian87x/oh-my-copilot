import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

// Memory-mode config lives in .omp/config.json (same store loadCopilotConfig
// reads). Off by default — the review pass costs an extra cheap-model call per
// session, so it only runs when the user opts in.

export type MemoryMode = "off" | "on";
export const DEFAULT_REVIEW_MODEL = "gpt-5-mini";
export const DEFAULT_MIN_MESSAGES = 4;

export interface MemoryConfig {
  memoryMode: MemoryMode;
  memoryReviewModel: string;
  memoryReviewMinMessages: number;
}

function configPath(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "config.json");
}

function readRaw(cwd: string): Record<string, unknown> {
  const p = configPath(cwd);
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readMemoryConfig(cwd: string): MemoryConfig {
  const raw = readRaw(cwd);
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

/** Persist a single memory key, preserving all other config.json keys. Atomic. */
export function setMemoryConfigValue(
  cwd: string,
  key: "memoryMode" | "memoryReviewModel" | "memoryReviewMinMessages",
  value: string,
): void {
  const raw = readRaw(cwd);
  raw[key] = value;
  const p = configPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
}
