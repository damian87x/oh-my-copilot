import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ompRoot } from "./omp-root.mjs";

function manifestPath(directory, sessionId) {
  const key = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return join(ompRoot(directory), ".omp", "ultragoal", key, "manifest.json");
}

export function readUltragoalManifest(directory, sessionId) {
  if (!sessionId || sessionId === "unknown") return undefined;
  const path = manifestPath(directory, sessionId);
  if (!existsSync(path)) return undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (
      manifest?.schemaVersion !== 1
      || manifest.sessionId !== sessionId
      || !Array.isArray(manifest.stories)
    ) {
      return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

/**
 * Ultragoal context for an active Goal. When the Goal has a generation, only
 * plans bound to that same generation inject — unbound or mismatched plans are
 * suppressed so replace cannot zombie-steer.
 */
export function selectUltragoalForGoal(manifest, goalGeneration) {
  if (!manifest) return undefined;
  if (goalGeneration !== undefined) {
    if (manifest.goalGeneration !== goalGeneration) return undefined;
  }
  return manifest;
}

export function formatUltragoalContext(manifest) {
  if (!manifest || manifest.status === "complete") return "";
  if (manifest.status === "awaiting_gate") {
    return [
      `[ULTRAGOAL GATE REQUIRED: revision ${manifest.revision}]`,
      `Objective: ${manifest.objective}`,
      "All stories have criterion evidence. Run the verifier, code-reviewer, and architect gate before Goal completion.",
    ].join("\n");
  }
  const story = manifest.stories.find((candidate) => candidate.id === manifest.activeStoryId);
  if (!story) {
    const next = manifest.stories.find((candidate) => candidate.status === "pending");
    return next
      ? `[ULTRAGOAL READY]\nNext: ${next.id} — ${next.title}\nStart it with \`omp ultragoal next\` using a unique operation ID.`
      : "";
  }
  return [
    `[ULTRAGOAL STORY ${story.id}]`,
    `Title: ${story.title}`,
    `Objective: ${story.objective}`,
    ...story.criteria.map((criterion) =>
      `${criterion.evidence?.length ? "[x]" : "[ ]"} ${criterion.id}: ${criterion.text}`),
    "Attach evidence to every criterion, then checkpoint this story before starting the next.",
  ].join("\n");
}
