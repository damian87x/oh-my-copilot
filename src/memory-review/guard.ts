import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

// The review can be triggered from two places — the sessionEnd hook (detached)
// and the omp wrapper post-exit (headless `-p`). Both may fire for the same
// session, so the claim must be atomic: an exclusive-create write (`wx`) is the
// race-free "exactly one winner" primitive. A read-then-write check would race.

function reviewDir(cwd: string): string {
  return join(ompRoot(cwd), ".oh-my-copilot", "memory-review");
}

function claimPath(cwd: string, uuid: string): string {
  const safe = String(uuid).replace(/[^a-zA-Z0-9._-]+/g, "-") || "unknown";
  return join(reviewDir(cwd), `.claim-${safe}`);
}

/** Atomically claim a session for review. Returns true only for the winner. */
export function claimSession(cwd: string, uuid: string): boolean {
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
