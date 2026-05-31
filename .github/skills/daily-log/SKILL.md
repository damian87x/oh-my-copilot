---
name: daily-log
description: Keep a simple per-project daily memory log under the project's daily-memory directory. Review it at session start when relevant, set today's goal, append milestones, and summarize before wrapping up. Use when the user says /daily-log, asks to record/recall what was done, or at end of session.
---

# Daily Log

A lightweight, human-readable journal stored **per project** at `.omp/memory/daily/<YYYY-MM-DD>.md`.
Each day has a `## Goal` and a timestamped `## Log`. It is written and read through MCP tools:

- `daily_log_set_goal { goal }` — set/replace today's goal (the day's intent).
- `daily_log_add { text }` — append a timestamped bullet to today's log.
- `daily_log_read { days? }` — read today + the previous `days` days (default 1).

`cwd` defaults to the current project, so every project keeps its own log automatically.

## When to use each

### At session start (review)
The SessionStart hook injects a one-line breadcrumb, e.g.:

```
[DAILY LOG] Goal: <today's goal>
N entries logged in the last 7 days — call daily_log_read to load if relevant.
```

If the breadcrumb looks relevant to what the user is asking for — same feature, an open
goal, or continuation of yesterday's work — call `daily_log_read` to pull the full recent
log. If the new request is clearly unrelated, **skip it**; loading is optional.

### When intent is established
Once you and the user agree on what today is about, call `daily_log_set_goal` with a short
one-line goal (e.g. "Ship the daily-log feature").

### At milestones
After a meaningful step — a decision made, a feature landed, a blocker hit — call
`daily_log_add` with a concise note. Record *what changed and why*, not narration.
Good: "Chose breadcrumb+lazy-load over always-inject to keep start message small."
Avoid: "Ran the build."

### Nudge
Every ~10 prompts the UserPromptSubmit hook injects:

```
[DAILY LOG] You've made progress this session — consider daily_log_add ...
```

Treat it as a reminder to capture anything important since the last entry.

### Before wrapping up (the real end-of-session write)
When the user signals they're done, **summarize the session into the log** with one or two
`daily_log_add` calls: what was accomplished, key decisions, and the next step for tomorrow.
The SessionEnd hook cannot reach the model, so this end-of-session summary happens here.

## Notes
- Keep entries short; the log is a memory aid, not a transcript.
- The file is safe to hand-edit: the tools preserve your lines in the Goal and Log
  sections verbatim (only blank spacer lines between entries are dropped on rewrite).
- Do not put secrets in the log — it is a plain file committed nowhere by this skill but
  readable by anyone with repo access.
