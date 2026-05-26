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
