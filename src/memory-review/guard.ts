import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";
import { migrateLegacyQuarantine, reviewDir } from "./quarantine.js";

// The review can be triggered from two places — the sessionEnd hook (detached)
// and the omp wrapper post-exit (headless `-p`). Both may fire for the same
// session, so the claim must be atomic: an exclusive-create write (`wx`) is the
// race-free "exactly one winner" primitive. A read-then-write check would race.

function safeClaimName(uuid: string): string {
  const safe = String(uuid).replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
  return `.claim-${safe}`;
}

function claimPath(cwd: string, uuid: string): string {
  return join(reviewDir(cwd), safeClaimName(uuid));
}

/** Atomically claim a session for review. Returns true only for the winner. */
export function claimSession(cwd: string, uuid: string): boolean {
  migrateLegacyQuarantine(cwd); // a legacy claim must still dedupe this session
  // Migration is best-effort; if it could not move a legacy claim (permissions,
  // EXDEV), the claim must still count or the session gets reviewed twice.
  const legacy = join(ompRoot(cwd), ".oh-my-copilot", "memory-review", safeClaimName(uuid));
  if (existsSync(legacy)) return false;
  const p = claimPath(cwd, uuid);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, new Date().toISOString(), { flag: "wx" }); // EEXIST if already claimed
    return true;
  } catch {
    return false;
  }
}

/** Release a claim so the session can be retried — used on no-write failure
 *  paths (model error, unparseable output) where nothing was persisted. */
export function releaseClaim(cwd: string, uuid: string): void {
  try {
    unlinkSync(claimPath(cwd, uuid));
  } catch {
    // a missing claim is fine
  }
}
