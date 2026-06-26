---
name: teach
description: Stateful multi-session teaching loop. Builds knowledge, skills, and wisdom from trusted sources via short interactive lessons grounded in a mission. Use with /teach when the user wants to learn a topic over time.
---

# Teach

Use `/teach <topic>` to learn a topic across sessions.

Stateful. User learns over many sessions inside a dedicated teaching workspace.

## Workspace location

Never scatter teaching files into an unrelated repo. Before writing anything:

- If the current dir is already a teaching workspace (has `MISSION.md`), use it.
- If the current dir is a code project (`.git`, `package.json`, source tree), do **not** write here. Propose a dedicated dir — default `~/learn/<topic-slug>/` — and confirm before creating it.
- Otherwise, treat the current dir as the workspace.

## When invoked without a topic

Ask: "What do you want to learn?" — then wait.

## Workspace files

State lives in the workspace dir (see above). Create files lazily — only when first needed.

- `MISSION.md` — why the user learns this. Grounds everything. Format: `references/mission-format.md`.
- `RESOURCES.md` — trusted sources for knowledge + communities for wisdom. Format: `references/resources-format.md`.
- `GLOSSARY.md` — canonical terms for the topic. Format: `references/glossary-format.md`.
- `lessons/0001-<slug>.html` — the main output. One self-contained lesson per file, number increments.
- `reference/*.html` — compressed cheat sheets, built to print well, for quick reference.
- `assets/*` — reusable components (CSS, quiz widgets, diagram helpers) shared across lessons.
- `learning-records/0001-<slug>.md` — decision-grade insights that steer future sessions. Format: `references/learning-record-format.md`.
- `NOTES.md` — user teaching preferences and working notes.

## Steps

1. **Mission first.** If `MISSION.md` is missing or vague, interview the user before teaching. No mission = abstract lessons. Format: `references/mission-format.md`.
2. **Gather knowledge.** Find high-trust sources, log in `RESOURCES.md`. Never trust parametric knowledge.
3. **Find the zone.** Read `learning-records/` + mission. Teach the most relevant thing that challenges "just enough".
4. **Build the lesson.** Reuse `assets/` components first. Write `lessons/NNNN-<slug>.html`. Open it via CLI if possible.
5. **Make it stick.** Add a feedback loop (quiz, task) for skill practice. Cite every claim with a source link.
6. **Record.** Write a learning record when the user shows real understanding, discloses prior knowledge, fixes a misconception, or shifts the mission.

## Rules

- One mission per workspace. Two topics = two workspaces.
- Lessons are short — fit working memory, one tangible win each, tied to the mission.
- Lessons beautiful + readable (Tufte). User revisits them.
- Every lesson: links to other lessons/refs, one primary source, a "ask your teacher follow-ups" reminder.
- Difficulty is the enemy for knowledge, the tool for skills. Build storage strength via retrieval, spacing, interleaving.
- Quiz answers: same word + char count. No format clues.
- Cite everything. Bare claims kill trust.
- Glossary is opinionated: one term per concept, list aliases to avoid. Add a term only after the user understands it.
- Wisdom = real-world practice. Default to answering, then point to a high-reputation community. Respect opt-out.
- Confirm before changing the mission; record the change as a learning record.

## Reference docs

Read the matching file only when you write that artifact:

- `references/mission-format.md` — MISSION.md template + rules
- `references/resources-format.md` — RESOURCES.md structure
- `references/glossary-format.md` — GLOSSARY.md structure
- `references/learning-record-format.md` — learning record template, numbering, when to write
- `references/example-oh-my-copilot.md` — worked example: seed files + lesson arc for teaching oh-my-copilot itself

## Output

- `Mission` — current `MISSION.md` state (or "interviewing")
- `Lesson` — path written + one-line summary
- `Practice` — the feedback loop included
- `Recorded` — any learning record written, or `-`

## oh-my-copilot ties

- Set/update the repo objective with `/goal` when the mission is established or shifts.
- Run `/self-evolve` at session end to capture teaching corrections.
- To teach oh-my-copilot itself (`/teach oh-my-copilot`), follow `references/example-oh-my-copilot.md` — it seeds `MISSION.md` + `RESOURCES.md` from first-party docs, so skip the web search.
