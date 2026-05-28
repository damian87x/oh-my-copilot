---
name: pipeline
description: State-machine orchestrator that chains research, grilling, planning, ticketing, and execution into a flexible delivery pipeline. Use when user says /pipeline, wants a full delivery workflow, or needs to go from research to implementation with optional ticket integration.
---

# Pipeline — delivery orchestrator

`/pipeline` is a state-machine that walks you through a full delivery loop, phase by phase. Each phase delegates to an existing skill. You can start from any phase, skip phases, and handle tickets at any point.

## Default flow

```
TICKET IN → RESEARCH → GRILL → PLAN → TICKET OUT → EXECUTE
(optional)   /research   /grill-me  /ralplan  /jira-ticket   /team or
              -codebase                                       /ralph
```

Every phase is optional. The orchestrator guides — the user decides.

## When invoked

### 1. Greet and orient

Present the pipeline phases as a numbered list and ask where to start:

```
Pipeline phases:
  0. Ticket input — read an existing ticket as context (optional)
  1. Research    — deep-dive the codebase (/research-codebase)
  2. Grill       — disambiguate decisions (/grill-me)
  3. Plan        — implementation-ready plan (/ralplan)
  4. Ticket out  — create or update a ticket (/jira-ticket)
  5. Execute     — deliver via /team (parallel) or /ralph (single)

Where should we start?
  → Full pipeline from the top
  → I have a ticket reference
  → I have research (file or context)
  → I have a plan — skip to ticket or execute
```

Wait for the user's answer. Parse their intent:

- **Full pipeline**: start at Phase 0
- **Has a ticket**: read the ticket (Phase 0), then continue to Phase 1
- **Has research**: record the research path/context, start at Phase 2
- **Has a plan**: start at Phase 4 or 5
- **Specific phase number or name**: jump directly there

### 2. Track state

Use the SQL session_state table to carry context between phases:

```sql
CREATE TABLE IF NOT EXISTS session_state (key TEXT PRIMARY KEY, value TEXT);
```

Keys used by the pipeline:

| Key | Content |
|-----|---------|
| `pipeline_phase` | Current phase number (0–5) |
| `ticket_key` | Ticket key if one exists |
| `ticket_context` | Problem statement + AC extracted from ticket |
| `research_path` | Path to research doc |
| `research_summary` | Key findings from research (compact) |
| `grill_decisions` | Resolved decisions from grilling |
| `plan_summary` | Implementation plan summary from ralplan |
| `execution_mode` | `team` or `ralph` |

Track phase completion with the SQL todos table.

---

## Phase 0 — Ticket Input (optional)

**Purpose**: Load an existing ticket to seed the pipeline with problem context.

**If ticket provided**: read it, extract problem statement and acceptance criteria, store in `session_state`.

**If no ticket**: skip — a ticket can be created later in Phase 4.

**Transition**: Present Phase 1 (Research) with option to skip.

---

## Phase 1 — Research (`/research-codebase`)

**Purpose**: Build a technical map of the relevant codebase area.

Invoke the `/research-codebase` skill. Feed it the ticket context (if available) as the research question. Wait for the research document. Store the document path and a compact summary in `session_state`.

**Transition**: Present Phase 2 (Grill) with option to skip.

---

## Phase 2 — Grill (`/grill-me`)

**Purpose**: Resolve ambiguity before planning.

1. State current understanding from research + ticket context in 1–2 bullets
2. Ask exactly one question with a recommended answer
3. Explain what the answer unlocks
4. Repeat until enough is known for `/ralplan`

Store resolved decisions in `session_state.grill_decisions`.

**Transition**: Present Phase 3 (Plan) — this phase should rarely be skipped.

---

## Phase 3 — Plan (`/ralplan`)

**Purpose**: Produce an implementation-ready plan with risks, acceptance criteria, and test shape.

Invoke `/ralplan` with all accumulated context (ticket, research, grill decisions).

Parse the "Ready for" section to determine suggested execution mode (`/team` or `/ralph`).

Store plan summary in `session_state.plan_summary`.

**Transition**: Present Phase 4 (Ticket) with option to skip.

---

## Phase 4 — Ticket Output (create / update / skip)

**Purpose**: Create or update a ticket with the plan.

### Path A — No ticket exists
- Invoke `/jira-ticket` to draft content from the plan + research
- Present the draft for review
- On approval, output the payload (or use project-specific tooling to create)

### Path B — Ticket already exists
- Format the plan as a comment
- Post as an update

### Path C — Sub-tasks needed
- Create sub-tasks mapping to plan slices

**Transition**: Present Phase 5 (Execute).

---

## Phase 5 — Execute (`/team` or `/ralph`)

**Purpose**: Deliver the implementation.

Present the execution choice:
> The plan suggests {execution_mode}. Shall I proceed, or would you prefer the other option?
>   → /team — parallel tmux panes (for independent lanes)
>   → /ralph — single-owner execute-fix-verify loop

### If `/team`:
Extract independent lanes from the plan. Build self-contained prompts for each lane.

### If `/ralph`:
Compile the full task from: plan + ticket context + research.

---

## Phase transitions

At every phase boundary:

1. **Summarise** what was accomplished (1–2 lines)
2. **Show progress**:
   ```
   ✅ Ticket In → ✅ Research → 🔄 Grill → ⬚ Plan → ⬚ Ticket Out → ⬚ Execute
   ```
3. **Present next phase** with options: Run, Skip, Jump to, Stop

Use `ask_user` — never auto-advance without user confirmation.

## Resuming a pipeline

If session state already has pipeline data, present: "I see an in-progress pipeline. Resume, or start fresh?"

## Important rules

- **Delegate, don't duplicate** — each phase invokes the real skill
- **Carry context forward** — every phase reads from and writes to `session_state`
- **User is in control** — never auto-advance
- **Ticket flexibility** — tickets can enter or exit the pipeline, or both, or neither
