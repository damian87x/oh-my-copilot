import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

// Memory-review writes proposed directives to a GATED pending queue (never
// auto-applied). Without a nudge that queue is invisible and rots, so the
// sessionStart hook surfaces a count + how to promote. Promotion stays manual:
// `omp project-memory add-directive "<rule>"` then remove the line.

function pendingPath(cwd) {
  const current = join(ompRoot(cwd), ".omp", "memory-review", "pending-directives.md");
  if (existsSync(current)) return current;
  // pre-migration queue — omp moves it under .omp/ on the next review
  return join(ompRoot(cwd), ".oh-my-copilot", "memory-review", "pending-directives.md");
}

/** Count unchecked ("- [ ]") items in the pending-directives queue. */
export function countPendingDirectives(cwd) {
  const p = pendingPath(cwd);
  if (!existsSync(p)) return 0;
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => /^\s*-\s*\[\s*\]\s+\S/.test(line)).length;
  } catch {
    return 0;
  }
}

/** SessionStart nudge string, or "" when nothing is pending. */
export function pendingDirectivesNudge(cwd) {
  const n = countPendingDirectives(cwd);
  if (n === 0) return "";
  return (
    `[MEMORY REVIEW] ${n} proposed directive${n === 1 ? "" : "s"} await your review in ` +
    `.omp/memory-review/pending-directives.md — promote the ones you want with ` +
    "`omp project-memory add-directive \"<rule>\"`, then delete the line."
  );
}
