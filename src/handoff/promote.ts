import { addNote } from "../project-memory.js";
import { readHandoff } from "./store.js";

export interface PromoteResult {
  ok: boolean;
  noteId?: string;
  reason?: string;
}

/**
 * Promote stable facts from a closed/archived handoff into durable project
 * memory (a note). Handoff remains the continuation artifact; memory gets
 * stable knowledge only.
 */
export function promoteHandoffToMemory(cwd: string, id: string): PromoteResult {
  let handoff;
  try {
    handoff = readHandoff(cwd, id);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!handoff) return { ok: false, reason: `handoff not found: ${id}` };
  if (handoff.state === "active") {
    return { ok: false, reason: "close or archive the handoff before promoting to memory" };
  }

  const lines: string[] = [
    `Promoted from handoff \`${handoff.id}\`.`,
    "",
    `**Objective:** ${handoff.objective}`,
  ];
  if (handoff.done.length) {
    lines.push("", "**Done:**", ...handoff.done.map((d) => `- ${d}`));
  }
  if (handoff.verification_status) {
    lines.push("", `**Verification:** ${handoff.verification_status}`);
  }
  if (handoff.references.length) {
    lines.push(
      "",
      "**References:**",
      ...handoff.references.map((r) => {
        const target = r.url ?? r.path ?? "";
        return `- ${r.label ? `${r.label}: ` : ""}${target}`;
      }),
    );
  }

  const title = `Handoff: ${handoff.objective}`.slice(0, 80);
  const noteId = addNote(cwd, title, lines.join("\n"));
  return { ok: true, noteId };
}
