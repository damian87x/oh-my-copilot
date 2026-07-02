import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ompRoot } from "../omp-root.js";

// Quarantine store for review output that must never be auto-loaded:
// pending directives + session claims live in .omp/memory-review/, learned-
// skill drafts and the self-evolve ledger in .omp/self-evolve/. Copilot CLI
// reads neither path — only .github/skills/ auto-loads — so quarantined
// content stays inert until a human promotes it.

const LEGACY_DIRNAME = ".oh-my-copilot";
const PENDING_FILENAME = "pending-directives.md";

export function reviewDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "memory-review");
}

export function selfEvolveDir(cwd: string): string {
  return join(ompRoot(cwd), ".omp", "self-evolve");
}

export function draftsDir(cwd: string): string {
  return join(selfEvolveDir(cwd), "drafts");
}

/** Slugs already covered by a quarantined draft or a promoted skill
 *  (`.github/skills/<slug>` or `.github/skills/learned-<slug>`) — the dedup
 *  set for automated self-evolve, so reviews never re-propose known skills. */
export function existingSkillSlugs(cwd: string): string[] {
  const slugs = new Set<string>();
  for (const dir of [draftsDir(cwd), join(ompRoot(cwd), ".github", "skills")]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) slugs.add(entry.name.replace(/^learned-/, ""));
      }
    } catch {
      // missing dir means nothing known there
    }
  }
  return [...slugs].sort();
}

/** Directive texts already sitting in the pending-review queue (checked or
 *  unchecked) — proposed once already, so a review must not re-queue them. */
export function pendingDirectiveTexts(cwd: string): string[] {
  try {
    const p = join(reviewDir(cwd), PENDING_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => /^\s*-\s*\[[ xX]?\]/.test(l))
      .map((l) => l.replace(/^\s*-\s*\[[ xX]?\]\s*/, "").trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

// Move legacy entries into dest, preserving data: current state always wins.
// Conflicts are left in place except pending directives (appended so no
// proposal is lost) and claim files (duplicates — the timestamps differ but
// either one dedupes the session, so the legacy copy is dropped).
function mergeMove(src: string, dest: string): void {
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    return;
  }
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    if (!existsSync(to)) {
      renameSync(from, to);
    } else if (lstatSync(from).isDirectory() && lstatSync(to).isDirectory()) {
      // lstat, not stat: never recurse THROUGH a symlink — a planted link could
      // otherwise make the merge move files belonging to a tree outside .omp/.
      mergeMove(from, to);
    } else if (entry === PENDING_FILENAME) {
      const legacy = readFileSync(from, "utf8")
        .split("\n")
        .filter((l) => /^\s*-\s*\[\s*\]/.test(l))
        .join("\n");
      if (legacy) appendFileSync(to, `${legacy}\n`, "utf8");
      rmSync(from);
    } else if (entry.startsWith(".claim-")) {
      rmSync(from);
    }
    // any other conflict: leave the legacy entry where it is
  }
  if (readdirSync(src).length === 0) rmdirSync(src);
}

/** Move legacy `.oh-my-copilot/` quarantine state under `.omp/`. Idempotent
 *  and best-effort: memory writes must not fail because a migration could not
 *  complete (read-only checkout, permissions), so errors are swallowed. */
export function migrateLegacyQuarantine(cwd: string): void {
  try {
    const legacyRoot = join(ompRoot(cwd), LEGACY_DIRNAME);
    if (!existsSync(legacyRoot)) return;
    const moves: Array<[string, string]> = [
      [join(legacyRoot, "memory-review"), reviewDir(cwd)],
      [join(legacyRoot, "self-evolve"), selfEvolveDir(cwd)],
    ];
    for (const [src, dest] of moves) {
      // lstat: a symlinked legacy subtree is left in place, never traversed
      if (existsSync(src) && lstatSync(src).isDirectory()) mergeMove(src, dest);
    }
    if (readdirSync(legacyRoot).length === 0) rmdirSync(legacyRoot);
  } catch {
    // best-effort
  }
}
