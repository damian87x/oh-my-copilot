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
  writeFileSync,
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

const UNCHECKED_LINE = /^\s*-\s*\[\s*\]\s+\S/;

/** Unchecked queue items, in file order. The 1-based position in this array is
 *  the index accepted by promote-directive / dismiss-directive. */
export function listPendingDirectives(cwd: string): string[] {
  try {
    const p = join(reviewDir(cwd), PENDING_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => UNCHECKED_LINE.test(l))
      .map((l) => l.replace(/^\s*-\s*\[\s*\]\s*/, "").trim());
  } catch {
    return [];
  }
}

/** Remove 1-based unchecked items (as returned by listPendingDirectives) from
 *  the queue; returns the texts removed. All other lines (header, checked
 *  items, prose) are preserved verbatim. Atomic rewrite; best-effort. */
export function removePendingDirectives(cwd: string, indexes: number[]): string[] {
  const p = join(reviewDir(cwd), PENDING_FILENAME);
  if (!existsSync(p)) return [];
  const drop = new Set(indexes);
  const removed: string[] = [];
  try {
    const lines = readFileSync(p, "utf8").split("\n");
    let position = 0;
    const kept: string[] = [];
    for (const line of lines) {
      if (UNCHECKED_LINE.test(line)) {
        position += 1;
        if (drop.has(position)) {
          removed.push(line.replace(/^\s*-\s*\[\s*\]\s*/, "").trim());
          continue;
        }
      }
      kept.push(line);
    }
    if (removed.length > 0) {
      const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, kept.join("\n"), "utf8");
      renameSync(tmp, p);
    }
    return removed;
  } catch {
    return [];
  }
}

// Move legacy entries into dest, preserving data: current state always wins.
// Conflicts are left in place except pending directives (appended so no
// proposal is lost) and claim files (duplicates — the timestamps differ but
// either one dedupes the session, so the legacy copy is dropped).
// TOCTOU-safe by construction: stat once and act on that snapshot inside a
// per-entry try/catch, so an entry changing mid-migration degrades to "leave
// it in place for the next best-effort pass" instead of corrupting the move.
function statOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function mergeMove(src: string, dest: string): void {
  if (!statOrNull(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    try {
      renameSync(src, dest);
      return;
    } catch {
      // dest appeared concurrently or EXDEV — fall through to a per-entry merge
    }
  }
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(dest, entry);
    try {
      const fromStat = statOrNull(from);
      if (!fromStat) continue; // vanished since readdir
      const toStat = statOrNull(to);
      if (!toStat) {
        renameSync(from, to);
      } else if (fromStat.isDirectory() && toStat.isDirectory()) {
        // lstat, not stat: never recurse THROUGH a symlink — a planted link could
        // otherwise make the merge move files belonging to a tree outside .omp/.
        mergeMove(from, to);
      } else if (entry === PENDING_FILENAME) {
        const legacy = readFileSync(from, "utf8")
          .split("\n")
          .filter((l) => /^\s*-\s*\[\s*\]/.test(l))
          .join("\n");
        // appendFileSync creates `to` if it vanished after the stat — either
        // way no queued proposal is lost
        if (legacy) appendFileSync(to, `${legacy}\n`, "utf8");
        rmSync(from, { force: true });
      } else if (entry.startsWith(".claim-")) {
        rmSync(from, { force: true });
      }
      // any other conflict: leave the legacy entry where it is
    } catch {
      // entry changed mid-migration — leave it for the next pass
    }
  }
  try {
    rmdirSync(src); // fails ENOTEMPTY when conflicts remain — that is the point
  } catch {
    // keep the non-empty legacy dir
  }
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
      // single lstat snapshot: a symlinked legacy subtree is left in place,
      // never traversed; a vanished one is skipped
      const st = statOrNull(src);
      if (st?.isDirectory()) mergeMove(src, dest);
    }
    rmdirSync(legacyRoot); // fails ENOTEMPTY when user files remain — caught below
  } catch {
    // best-effort
  }
}
