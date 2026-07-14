/** Lifecycle states for a task handoff artifact. */
export type HandoffState = "active" | "closed" | "archived";

/** External artifact pointer — path or URL, never duplicated body content. */
export interface HandoffReference {
  label?: string;
  path?: string;
  url?: string;
}

export interface HandoffGeneration {
  /** How the packet was built. */
  mode: "deterministic" | "llm" | "explicit";
  /** Number of model calls made while generating (0 for deterministic). */
  model_calls: number;
  /** True when a cost-bearing LLM summarization ran (or was billed). */
  cost_bearing: boolean;
  /** Optional human-readable note (e.g. cost warning). */
  warning?: string;
}

/**
 * Fixed-field handoff packet (epic #26).
 * Temporary task continuation state — not durable project memory.
 */
export interface Handoff {
  id: string;
  state: HandoffState;
  objective: string;
  done: string[];
  pending: string[];
  blockers: string[];
  files_touched: string[];
  verification_status: string;
  next_action: string;
  references: HandoffReference[];
  /** Skills the next agent should consider. */
  suggested_skills: string[];
  /** Optional focus for the next session (from user argument). */
  focus?: string;
  created_at: string;
  updated_at: string;
  generation: HandoffGeneration;
}

/** Active-index entry: pointer only (id + one-line objective). */
export interface HandoffPointer {
  id: string;
  objective: string;
  updated_at: string;
}

export interface HandoffIndex {
  version: 1;
  active: HandoffPointer[];
}

export interface CreateHandoffInput {
  objective?: string;
  done?: string[];
  pending?: string[];
  blockers?: string[];
  files_touched?: string[];
  verification_status?: string;
  next_action?: string;
  references?: HandoffReference[];
  suggested_skills?: string[];
  focus?: string;
  /** Force LLM path (cost-bearing). */
  llm?: boolean;
  /** ISO timestamp override (tests). */
  now?: string;
  /** Id override (tests only). */
  id?: string;
}

export interface CreateHandoffResult {
  handoff: Handoff;
  path: string;
  /** True when a cost-bearing LLM summarization was used. */
  cost_bearing: boolean;
  warning?: string;
}
