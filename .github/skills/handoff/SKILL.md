---
name: handoff
description: Create or resume a task handoff so a fresh agent can continue unfinished work. Persist via omp handoff CLI (never write handoff files yourself). Use when the user says /handoff, wants to pause mid-task, or resume prior work.
---

# Handoff

Task-scoped continuation packets for unfinished work. Handoffs are **temporary**
(active → closed/archived). Stable knowledge belongs in project memory
(`/daily-log`, `omp project-memory`), not here.

**Source of truth is the CLI.** Persist only through `omp handoff … --json`.
Do not write `.omp/handoffs/` yourself.

## Modes

### Create — `/handoff` with an active task (or a focus argument)

When the user is mid-task and wants to stop, or passes an argument describing
what the next session should do:

1. **Collect** (from conversation + workspace; keep bullets short):
   - `objective` — what this task is
   - `done` — completed steps
   - `pending` — remaining steps
   - `blockers` — failures / waits
   - `files_touched` — paths that matter
   - `verification_status` — tests/build status
   - `next_action` — single concrete next step
2. **Reference** existing artifacts by path or URL (issues, PRs, plans, commits).
   Do **not** restate their content.
3. **Redact** API keys, passwords, tokens, and PII. Never put secrets or env
   values into a handoff.
4. **Persist** with the CLI (deterministic; no model cost):

```text
omp handoff create --json \
  --objective "…" \
  --done "…" --done "…" \
  --pending "…" \
  --blockers "…" \
  --files "path/a" --files "path/b" \
  --verification "…" \
  --next "…" \
  --ref "path/or/url" \
  --skill "tdd" --skill "verify" \
  --focus "optional next-session focus"
```

If the user passed an argument to `/handoff`, put it in `--focus` and tailor
`objective` / `next_action` to that focus.

Prefer deterministic create (no model cost). `--llm` / `handoff-llm on` require
a real summarizer backend — until one is wired they fail with a clear error
rather than faking a model call.

5. Reply with the new handoff **id**, objective, and `next_action`.

### Resume — `/handoff` with no active task (or user asks to continue)

1. List open handoffs:

```text
omp handoff list --json
```

2. If several, pick the matching id (ask the user when ambiguous).
3. Load the full packet:

```text
omp handoff read <id> --json
```

4. Propose the handoff’s `next_action` and continue from `pending` / `blockers`.
5. When the task is finished:

```text
omp handoff close <id> --json
```

Optionally promote stable facts into durable memory:

```text
omp handoff close <id> --promote --json
```

## Suggested skills (for the next agent)

Include relevant skill names via `--skill` (e.g. `tdd`, `verify`, `code-review`,
`team`, `daily-log`). The handoff packet stores them for the resume path.

## Hard rules

- CLI only for persistence (`create` / `list` / `read` / `close` / `archive` / `prune`).
- Reference specs/plans/PRs by path or URL — never paste full bodies.
- Pointers only in managed context; never inject full handoff bodies into
  `copilot-instructions.md`.
- Closed/archived handoffs stay out of the default list.
- Handoff ≠ durable memory. Promote on close when facts should outlive the task.
