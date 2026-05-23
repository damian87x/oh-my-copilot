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

### 0. Once-per-session guard

Two checks. If **either** trips, stop immediately, say "self-evolve already ran this session", and do nothing else.

**Exception (both checks):** if the user explicitly retyped `/self-evolve` to force a re-run, skip both checks.

**Check A — conversation memory.** If you have already invoked `/self-evolve` in this conversation, stop.

**Check B — durable marker.** Read `.oh-my-copilot/self-evolve/.last-run-session` (single-line UUID, may not exist). Determine the current Copilot CLI session UUID via shell:

```
ls -td ~/.copilot/session-state/*/ 2>/dev/null | head -1 | xargs -n1 basename
```

If the marker file exists and its contents match the current session UUID, stop. (If `~/.copilot/session-state/` is empty or unreadable, skip Check B and rely on Check A alone.)

Check B survives session resume (`copilot --resume`) and conversation compaction, where Check A could miss the earlier invocation.

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

- `.github/skills/*/SKILL.md` (project skills, including any previously promoted `learned-*`)
- `.oh-my-copilot/self-evolve/drafts/*/SKILL.md` (in-flight drafts not yet promoted)
- `~/.copilot/skills/*/SKILL.md` (user skills, if present)

**Match bar (high, not vague).** A skill counts as covering this topic only if:

- its frontmatter `description` explicitly names the exact behavior the user kept correcting, **OR**
- it contains a `Do` or `Don't` bullet that, applied literally, would have prevented every correction in the cluster.

Generic adjacency does **not** count. A "code quality" skill does not cover "respect Python quote style"; a "respect-quotes" skill does. When in doubt, treat as not covered.

**If clearly covered**, do not draft. Append one note to the ledger and stop:

```
# covered-by: <existing-skill-name> | <topic>
```

**If covered ambiguously** (some bullets are adjacent but none are a direct match), still draft — but add a line to the new draft's `Source` section noting the overlap, so a human reviewer can decide on merge or supersede:

```
possible-duplicate-of: <existing-skill-name>
```

Bias: when unsure, draft. Drafts live in `.oh-my-copilot/self-evolve/drafts/` and are inert until a human promotes them, so a stray draft costs nothing while a missed pattern wastes signal.

### 5. Draft the new skill

**Path:** `.oh-my-copilot/self-evolve/drafts/<slug>/SKILL.md`

**This is outside `.github/skills/` on purpose.** Drafts must NOT live in the plugin's active skill root: anything under `.github/skills/` is loaded as an active skill on the next Copilot session, so a draft there would silently auto-arm before a human reviewed it. The `.oh-my-copilot/self-evolve/drafts/` location is never read by Copilot CLI; a human promotes a draft by moving its directory to `.github/skills/learned-<slug>/` (see `docs/self-evolve.md`).

- Slug rule: kebab-case of the topic, max 40 chars.
- The draft's frontmatter `name` should be `learned-<slug>` (matches the target dir name a human will promote it into).

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
Promote to active by moving this directory to .github/skills/learned-<slug>/.
```

### 6. Report to the user

State:

- how many corrections this session contributed to the ledger,
- whether any topic crossed the threshold,
- the path of any draft skill written,
- the path of the ledger.

### 7. Persist the session marker

Before exiting, write the current Copilot CLI session UUID to `.oh-my-copilot/self-evolve/.last-run-session` (overwrite, no newline needed). Use the same shell line as Step 0 to determine it. Subsequent invocations within the same session will short-circuit via Check B in Step 0.

If `~/.copilot/session-state/` was empty or unreadable in Step 0, write the literal string `unknown-session` so the marker exists but cannot accidentally match a real UUID later.

## Output discipline

- One ledger line per correction. Never batch into a paragraph.
- One draft skill per recurring topic. Never combine unrelated topics.
- Drafts always carry `status: draft`. A human promotes them by moving the draft directory from `.oh-my-copilot/self-evolve/drafts/<slug>/` into `.github/skills/learned-<slug>/` (and optionally deleting the `status: draft` line). Until that move, the draft is inert — Copilot CLI does not load it.
- If unsure whether something is a correction, skip it. False negatives are cheap; false positives pollute the loop.
