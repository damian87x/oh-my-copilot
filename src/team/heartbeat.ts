import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Heartbeat } from "./types.js";

export function writeHeartbeat(path: string, hb: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(hb), "utf8");
  renameSync(tmp, path);
}

export function readHeartbeat(path: string): Heartbeat | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return undefined;
  }
}

export function isHeartbeatStale(hb: Heartbeat | undefined, now: number = Date.now(), maxAgeMs = 30_000): boolean {
  if (!hb) return true;
  const last = Date.parse(hb.lastPollAt);
  if (!Number.isFinite(last)) return true;
  return now - last > maxAgeMs;
}
