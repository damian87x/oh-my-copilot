---
name: team
description: Thin handoff for parallel execution when a real provider team runtime exists; otherwise produce an unsupported handoff brief.
---

# team

Use when a plan has independent implementation lanes.

1. Confirm the plan has clear lanes, owners, risks, and verification commands.
2. If the current provider exposes a real team runtime, hand off with the full context and evidence requirements.
3. If no runtime exists, say this is unsupported here and output a handoff brief with lanes, files, tests, and stop criteria.
4. Do not emulate a durable team runtime inside this skill.
