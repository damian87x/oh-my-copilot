# Agent instructions

## Session lifecycle: self-evolve

Before ending a session, invoke `/self-evolve` to capture mistake patterns.

Trigger when any of these apply:

- The user says "done", "bye", "thanks", "wrapping up", "ship it", or types `/exit`.
- You finish the user's last task with no pending todos and they have not requested follow-up.

Skip when the session was fewer than 3 turns or contained no user corrections.

The skill lives at `.github/skills/self-evolve/SKILL.md`. It is self-contained: it tells you which signals count as corrections, where to log them, and when a recurring pattern should become a draft skill.
