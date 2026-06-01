---
name: daily-log
description: Keep a simple per-project daily memory log under the project's daily-memory directory. Review it at session start when relevant, set today's goal, append milestones, and summarize before wrapping up. Use when the user says /daily-log, asks to record/recall what was done, or at end of session.
---

# Daily Log

A lightweight, human-readable journal stored **per project** at `.omp/memory/daily/<YYYY-MM-DD>.md`.
Each day has a `## Goal` and a timestamped `## Log`. It is written and read through the `omp`
CLI (run these as shell commands):

- `omp daily-log set-goal "<text>"` — set/replace today's goal (the day's intent).
- `omp daily-log add "<text>"` — append a timestamped bullet to today's log.
- `omp daily-log read [--days N]` — read today + the previous N days (default 1).

The command writes under the current project's `.omp/`, so every project keeps its own log
automatically.

## When to use each

### At session start (review)
The SessionStart hook injects a one-line breadcrumb, e.g.:

```
[DAILY LOG] Goal: <today's goal>
N entries logged in the last 7 days — run `omp daily-log read` to load if relevant.
```

If the breadcrumb looks relevant to what the user is asking for — same feature, an open
goal, or continuation of yesterday's work — run `omp daily-log read` to pull the full recent
log. If the new request is clearly unrelated, **skip it**; loading is optional.

### When intent is established
Once you and the user agree on what today is about, run `omp daily-log set-goal "<text>"` with a
short one-line goal (e.g. "Ship the daily-log feature").

### At milestones
After a meaningful step — a decision made, a feature landed, a blocker hit — run
`omp daily-log add "<text>"` with a concise note. Record *what changed and why*, not narration.
Good: "Chose breadcrumb+lazy-load over always-inject to keep start message small."
Avoid: "Ran the build."

### Resume nudge (start of the next session)
There is no per-turn nudge. Instead, if a session did real work but wrote nothing,
the **next** SessionStart injects a one-line reminder:

```
[DAILY LOG] Your last session made progress but recorded nothing ...
```

Treat it as a prompt to capture what changed before moving on — or, better, summarize
into the log *before ending* the session (below), so the nudge never needs to fire.

### Before wrapping up (the real end-of-session write)
When the user signals they're done, **summarize the session into the log** with one or two
`omp daily-log add "<text>"` commands: what was accomplished, key decisions, and the next step
for tomorrow. The SessionEnd hook cannot reach the model, so this end-of-session summary happens here.

## Notes
- Keep entries short; the log is a memory aid, not a transcript.
- The file is safe to hand-edit: the CLI preserves your lines in the Goal and Log
  sections verbatim (only blank spacer lines between entries are dropped on rewrite).
- Do not put secrets in the log — it is a plain file committed nowhere by this skill but
  readable by anyone with repo access.
