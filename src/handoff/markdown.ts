import type { Handoff, HandoffGeneration, HandoffReference, HandoffState } from "./types.js";

/** Escape a string for a double-quoted YAML scalar. */
function yq(s: string): string {
  return `"${String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`;
}

function yamlStringList(key: string, items: string[], indent = 0): string[] {
  const pad = " ".repeat(indent);
  if (!items.length) return [`${pad}${key}: []`];
  const lines = [`${pad}${key}:`];
  for (const item of items) lines.push(`${pad}  - ${yq(item)}`);
  return lines;
}

function yamlRefs(refs: HandoffReference[]): string[] {
  if (!refs.length) return ["references: []"];
  const lines = ["references:"];
  for (const r of refs) {
    lines.push("  -");
    if (r.label) lines.push(`    label: ${yq(r.label)}`);
    if (r.path) lines.push(`    path: ${yq(r.path)}`);
    if (r.url) lines.push(`    url: ${yq(r.url)}`);
  }
  return lines;
}

function yamlGeneration(g: HandoffGeneration): string[] {
  const lines = [
    "generation:",
    `  mode: ${yq(g.mode)}`,
    `  model_calls: ${Math.floor(g.model_calls)}`,
    `  cost_bearing: ${g.cost_bearing ? "true" : "false"}`,
  ];
  if (g.warning) lines.push(`  warning: ${yq(g.warning)}`);
  return lines;
}

function bullets(items: string[]): string[] {
  if (!items.length) return ["_(none)_"];
  return items.map((i) => `- ${i}`);
}

/** Serialize a handoff to Markdown with YAML frontmatter. */
export function serializeHandoffMarkdown(h: Handoff): string {
  const fm = [
    "---",
    `id: ${yq(h.id)}`,
    `state: ${h.state}`,
    `objective: ${yq(h.objective)}`,
    `verification_status: ${yq(h.verification_status)}`,
    `next_action: ${yq(h.next_action)}`,
    `created_at: ${yq(h.created_at)}`,
    `updated_at: ${yq(h.updated_at)}`,
    ...yamlStringList("files_touched", h.files_touched),
    ...yamlStringList("suggested_skills", h.suggested_skills),
    ...yamlStringList("done", h.done),
    ...yamlStringList("pending", h.pending),
    ...yamlStringList("blockers", h.blockers),
    ...yamlRefs(h.references),
    ...yamlGeneration(h.generation),
  ];
  if (h.focus) fm.push(`focus: ${yq(h.focus)}`);
  fm.push("---");

  const body = [
    `# Handoff: ${h.objective}`,
    "",
    "## Done",
    ...bullets(h.done),
    "",
    "## Pending",
    ...bullets(h.pending),
    "",
    "## Blockers",
    ...bullets(h.blockers),
    "",
    "## Next",
    h.next_action || "_(none)_",
    "",
  ];

  return `${fm.join("\n")}\n\n${body.join("\n")}`;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return s;
}

/**
 * Minimal frontmatter parser for the fixed handoff schema we write.
 * Not a full YAML implementation — only the shapes we produce/consume.
 */
export function parseHandoffMarkdown(text: string): Handoff | null {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) return null;
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = trimmed.slice(4, end).trim();

  const data: Record<string, unknown> = {};
  let currentList: string[] | null = null;
  let currentListKey: string | null = null;
  let inGeneration = false;
  let inReferences = false;
  let currentRef: HandoffReference | null = null;
  const refs: HandoffReference[] = [];
  const generation: Partial<HandoffGeneration> = {};

  const flushList = () => {
    if (currentListKey && currentList) data[currentListKey] = currentList;
    currentList = null;
    currentListKey = null;
  };
  const flushRef = () => {
    if (currentRef && (currentRef.path || currentRef.url || currentRef.label)) {
      refs.push(currentRef);
    }
    currentRef = null;
  };

  for (const line of fm.split("\n")) {
    if (!line.trim()) continue;

    if (inGeneration) {
      const m = line.match(/^\s{2}([a-z_]+):\s*(.*)$/);
      if (m) {
        const k = m[1]!;
        const v = m[2]!.trim();
        if (k === "mode") generation.mode = unquote(v) as HandoffGeneration["mode"];
        else if (k === "model_calls") generation.model_calls = Number(v) || 0;
        else if (k === "cost_bearing") generation.cost_bearing = v === "true";
        else if (k === "warning") generation.warning = unquote(v);
        continue;
      }
      inGeneration = false;
    }

    if (inReferences) {
      if (/^\s{2}-\s*$/.test(line) || line.trim() === "-") {
        flushRef();
        currentRef = {};
        continue;
      }
      const rm = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
      if (rm && currentRef) {
        const k = rm[1]!;
        const v = unquote(rm[2]!);
        if (k === "label" || k === "path" || k === "url") currentRef[k] = v;
        continue;
      }
      flushRef();
      inReferences = false;
    }

    if (currentList) {
      const lm = line.match(/^\s+-\s+(.*)$/);
      if (lm) {
        currentList.push(unquote(lm[1]!));
        continue;
      }
      flushList();
    }

    if (/^generation:\s*$/.test(line)) {
      flushList();
      inGeneration = true;
      continue;
    }
    if (/^references:\s*\[\]\s*$/.test(line)) {
      flushList();
      data.references = [];
      continue;
    }
    if (/^references:\s*$/.test(line)) {
      flushList();
      inReferences = true;
      continue;
    }

    const emptyList = line.match(/^([a-z_]+):\s*\[\]\s*$/);
    if (emptyList) {
      flushList();
      data[emptyList[1]!] = [];
      continue;
    }

    const listStart = line.match(/^([a-z_]+):\s*$/);
    if (
      listStart &&
      ["done", "pending", "blockers", "files_touched", "suggested_skills"].includes(listStart[1]!)
    ) {
      flushList();
      currentListKey = listStart[1]!;
      currentList = [];
      continue;
    }

    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) {
      flushList();
      data[kv[1]!] = unquote(kv[2]!);
    }
  }
  flushList();
  flushRef();
  if (refs.length) data.references = refs;
  if (Object.keys(generation).length) data.generation = generation;

  const id = typeof data.id === "string" ? data.id : "";
  if (!id) return null;
  const state: HandoffState =
    data.state === "closed" || data.state === "archived" || data.state === "active"
      ? data.state
      : "active";
  const gen = (data.generation ?? {}) as Partial<HandoffGeneration>;
  const asStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  return {
    id,
    state,
    objective: typeof data.objective === "string" ? data.objective : id,
    done: asStringList(data.done),
    pending: asStringList(data.pending),
    blockers: asStringList(data.blockers),
    files_touched: asStringList(data.files_touched),
    verification_status:
      typeof data.verification_status === "string" ? data.verification_status : "unknown",
    next_action: typeof data.next_action === "string" ? data.next_action : "",
    references: Array.isArray(data.references) ? (data.references as HandoffReference[]) : [],
    suggested_skills: asStringList(data.suggested_skills),
    focus: typeof data.focus === "string" ? data.focus : undefined,
    created_at: typeof data.created_at === "string" ? data.created_at : new Date(0).toISOString(),
    updated_at: typeof data.updated_at === "string" ? data.updated_at : new Date(0).toISOString(),
    generation: {
      mode:
        gen.mode === "llm" || gen.mode === "explicit" || gen.mode === "deterministic"
          ? gen.mode
          : "deterministic",
      model_calls: typeof gen.model_calls === "number" ? gen.model_calls : 0,
      cost_bearing: Boolean(gen.cost_bearing),
      warning: typeof gen.warning === "string" ? gen.warning : undefined,
    },
  };
}
