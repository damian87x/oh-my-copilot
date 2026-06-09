# oh-my-copilot

Default behaviours installed with this repo. Override per project as needed.

## Approach
- Surface assumptions before coding.
- Prefer the simplest change that satisfies the request.
- Touch only what the task requires.
- Verify success with concrete checks: tests, output, behaviour.

## Validation
- Run tests for code you change.
- Read the diff before committing.
- If unsure about scope, ask.

## Skills
Slash commands under `.github/skills/<name>/SKILL.md` are auto-discovered by Copilot. See `omp list` for the catalog active in this project.

## Hooks
Lifecycle hooks declared in `hooks/hooks.json` invoke scripts in `scripts/`. Run `omp doctor` to verify discovery.

## Session lifecycle: self-evolve

Before ending a session, invoke `/self-evolve` to capture mistake patterns.

Trigger when any of these apply:

- The user says "done", "bye", "thanks", "wrapping up", "ship it", or types `/exit`.
- You finish the user's last task with no pending todos and they have not requested follow-up.

Skip when the session was fewer than 3 turns or contained no user corrections.

Invoke `/self-evolve` **at most once per session.** After it reports back, do not invoke it again — even if the user replies "thanks" or "done" to the report itself. Just acknowledge and end the session.

The skill lives at `.github/skills/self-evolve/SKILL.md`. It is self-contained: it tells you which signals count as corrections, where to log them, and when a recurring pattern should become a draft skill.

## Daily log & repo goal

Keep lightweight memory in `.omp/` so the next session has context. **Be sparse** — these are
memory aids, not a transcript. Float kills their value.

- **Repo goal** (`.omp/goal.md`, via `/goal`): set/update the one-line objective when it is
  established or genuinely shifts. Not every session.
- **Daily log** (`.omp/memory/daily/<date>.md`, via `/daily-log`):
  - When a heavy mode (`/ralph`, `/ralplan`, `/omp-autopilot`, `/team`, `/ultrawork`,
    `/ultraqa`) starts, set today's goal from its objective: `omp daily-log set-goal "<text>"`.
  - When such a mode finishes, add **one** concise summary entry — `omp daily-log add "<text>"`:
    what changed, key decisions, next step.
  - Otherwise add an entry only at a genuine milestone you judge worth remembering.
- **Project memory**: `omp project-memory add-directive "<rule>"` for a must-follow rule —
  directives are **injected at every session start** (never on-demand), so add only real,
  lasting rules and keep them few. `omp project-memory add-note "<title>" [--body "<text>"]`
  for durable facts; list them with `omp project-memory index` and load one with
  `omp project-memory read <id>` — bodies stay on disk until asked, so notes never bloat context.
- **Caps & retention:** keep directives to a handful (only the first ~12 are injected at start);
  a few daily entries per day — decisions and outcomes, not narration; skip trivial sessions;
  never log per skill invocation. Trim old day-files with `omp daily-log prune [--keep-days <n>]`
  (default 30).
