---
name: self-evolve
description: Capture user-correction patterns from this session and, when a pattern recurs, draft a new project skill. Use at end of session, when the user signals wrap-up, or when invoked directly.
---

# Self-Evolve

Use `/self-evolve` to turn this session's mistakes into reusable project skills.

## When to run

- User signals end-of-session ("done", "bye", "thanks", "/exit", "wrapping up", "ship it").
- You finish the user's last task with no pending todos and they have not requested follow-up.
- The user invokes `/self-evolve` directly.

**Skip if:** the session was fewer than 3 turns, or the session contained no user corrections.

## What counts as a "correction"

A user message right after one of your responses that pushes back on what you did. Signal phrases (case-insensitive):

- explicit rejection: "no", "wrong", "that's wrong", "not what i asked", "undo", "revert"
- redirection: "wait", "stop", "actually", "instead", "rather"
- prohibition: "don't", "do not"

Ignore false positives ("no problem", "stop the server", "don't worry") by checking that the phrase rebukes your prior action.

## The loop

### 1. Inspect this session

Walk back through the conversation and list every correction event. For each, record:

- **topic** — short kebab-case label (e.g. `trailing-newline-shell-output`, `python-string-quotes`, `unwanted-readme-edits`)
- **area** — file path or subsystem the correction touched, or `-` if none
- **summary** — one sentence: what you did wrong and what the user wanted instead

### 2. Append to the ledger

The ledger lives at `.oh-my-copilot/self-evolve/log.md`. Create the directory and file if missing. Append one entry per correction in this exact shape:

```
- YYYY-MM-DD | <topic> | <area> | <summary>
```

Keep entries chronological. Never rewrite past entries.

### 3. Count repeats

For each new topic from this session, grep the ledger for the same topic label. The count includes today's entries.

**Threshold: 3 occurrences.** Fewer → stop here.

### 4. Check existing coverage

Before drafting, list:

- `.github/skills/*/SKILL.md` (project skills)
- `~/.copilot/skills/*/SKILL.md` (user skills, if present)

If any existing skill's frontmatter `description` or body already addresses this topic, **do not draft.** Append one note to the ledger and stop:

```
# covered-by: <existing-skill-name> | <topic>
```

### 5. Draft the new skill

**Path:** `.github/skills/learned-<slug>/SKILL.md`

- The directory is at the top of `.github/skills/`, prefixed `learned-`. Do NOT nest under a `learned/` parent dir.
- The frontmatter `name` MUST equal the directory name exactly (lint enforces this).
- Slug rule: kebab-case of the topic, max 40 chars (so the full dir name `learned-<slug>` is at most 48 chars).

Write the file with this exact frontmatter and body:

```
---
name: learned-<slug>
description: <one sentence — when this skill should fire>
status: draft
---

# Learned: <human title>

Invoke `/learned-<slug>` when the trigger below applies.

## Trigger
<one-line condition derived from the recurring corrections>

## Do
<concrete instruction(s) that would have prevented the corrections>

## Don't
<the wrong behaviour you kept doing>

## Source
Drafted by /self-evolve from 3+ corrections in .oh-my-copilot/self-evolve/log.md.
Promote to active by removing the `status: draft` line.
```

### 6. Report to the user

State:

- how many corrections this session contributed to the ledger,
- whether any topic crossed the threshold,
- the path of any draft skill written,
- the path of the ledger.

## Output discipline

- One ledger line per correction. Never batch into a paragraph.
- One draft skill per recurring topic. Never combine unrelated topics.
- Drafts always carry `status: draft`. A human flips them to active by deleting that line.
- If unsure whether something is a correction, skip it. False negatives are cheap; false positives pollute the loop.
