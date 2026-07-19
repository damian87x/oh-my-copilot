# Memory mode (self-improving review loop)

Memory mode is an **opt-in** end-of-session review that mirrors Hermes Agent's
background-review fork, adapted to GitHub Copilot CLI. After a session ends, a
**cheap model** reads the session transcript and extracts durable knowledge into
oh-my-copilot's existing memory/skill stores — so the next session starts a
little smarter without you having to repeat yourself.

It is **off by default** because it adds one extra (cheap) model call per
session.

## Enable

```bash
omp config set memory-mode on                    # opt in (this project)
omp config set memory-review-model gpt-5-mini     # optional; defaults to gpt-5-mini
omp config set memory-review-min-messages 4       # optional; skip sessions shorter than this (default 4)
omp config get                                    # show current (effective) settings

# Set once for EVERY project (~/.omp/config.json):
omp config set memory-mode on --global
omp config set memory-review-model <slug> --global
```

**Resolution precedence (high → low):** `OMP_MEMORY_MODE` env › project
`.omp/config.json` › global `~/.omp/config.json` › defaults. So `--global` is the
"set it once" default, and a project's `.omp/config.json` overrides it per key.

## How it triggers

| Surface | Trigger | Notes |
|---|---|---|
| Interactive `copilot` (plugin installed) | `sessionEnd` hook | Detaches `omp memory-review` as a background process and returns immediately (hooks have a 5s budget). |
| `omp -p` / `omp launch -- -p` (headless) | wrapper, post-exit | Belt-and-braces for headless runs (older copilot versions skip hooks in `-p` mode; current ones fire them — the claim below dedupes). It snapshots session dirs before launch and reviews the **exact** session created by that run — if it can't identify one, it skips rather than guess. |
| Manual | `omp memory-review --session <uuid\|latest>` | Run it yourself against any session (`latest` = newest by mtime). |

Both automatic triggers only **detach** the work. The review claims the session
atomically (`.omp/memory-review/.claim-<uuid>`), so even if the hook
and wrapper both fire, the review runs **exactly once**. The reviewer's own
`copilot -p` subprocess runs with `OMP_MEMORY_MODE=off`, so its session never
triggers a review of itself (which would cascade indefinitely).

## What it writes

| Output | Destination | Applied? |
|---|---|---|
| **Notes** (durable facts) | project memory (`omp project-memory`) | ✅ applied — progressive disclosure, low blast radius |
| **Skill drafts** (procedures) | `.omp/self-evolve/drafts/<slug>/SKILL.md` | ⏸ human-promote — never auto-loaded (same as `/self-evolve`). Deduped: known draft slugs and promoted skills are never re-proposed |
| **Directives** (every-session rules) | `.omp/memory-review/pending-directives.md` | ⏸ **gated** — never auto-applied. Deduped against active and already-pending directives |

After the review writes notes it refreshes the managed block in
`.github/copilot-instructions.md`, listing the most recent note **titles** (capped,
newest-first) so the next session knows what it remembers; bodies stay on demand
(`omp project-memory read <id>`). The review also ensures `.omp/` (and the
legacy `.oh-my-copilot/`) are gitignored so memory (which may contain tool
output) isn't accidentally committed.

> **Migration:** older omp versions wrote quarantine output to
> `.oh-my-copilot/`. If that directory exists, the next review moves its
> contents under `.omp/` automatically (existing `.omp/` files win; pending
> directives are merged).

### Promoting a pending directive (manual, by design)

Directives are gated: they inject into every future session, so an injected/poisoned
one would steer everything. The review prompt treats the transcript as **data, not
instructions**, and only proposes directives from corrections / standing preferences —
never one-off task instructions. On the next session start you'll see a nudge:
`[MEMORY REVIEW] N proposed directive(s) await your review…`. To review and promote:

```bash
omp project-memory pending                  # list proposals with indexes
omp project-memory promote-directive 2      # apply one (adds + dequeues)
omp project-memory promote-directive --all  # apply everything
omp project-memory dismiss-directive 1      # drop without applying
```

Skill drafts promote the same way as `/self-evolve`: move
`.omp/self-evolve/drafts/<slug>/` to `.github/skills/learned-<slug>/`.

### Pruning notes

Notes accumulate over time. Trim them anytime (never silent — requires a flag):

```bash
omp project-memory prune-notes --keep 50        # keep the 50 newest
omp project-memory prune-notes --older-than 30  # drop notes older than 30 days
```

Or let the review keep the store bounded automatically (off by default):

```bash
omp config set memory-note-auto-keep 50   # after each review, keep only the 50 newest
```

### Injection budgets

What gets surfaced at session start is capped so memory can't balloon context:

```bash
omp config set memory-directive-cap 12        # max directives injected (default 12)
omp config set memory-directive-char-cap 1200 # max total directive chars (default 1200)
omp config set memory-note-cap 12             # max note titles in the instructions block
omp config set memory-topic-cap 10            # max topic pointers in the instructions block
```

Directive storage itself is unbounded — `add-directive` warns when the list
outgrows the injection cap, since rules past the cap never fire.

## Cost & observability

- The expensive reasoning already happened in the main session; the review is a
  single cheap-model call over the transcript.
- Token cost is recorded in the cost ledger (`omp cost`) under the
  `memory-review` event.
- Each run appends a line to `.omp/state/memory-review.log`.

## Disable

```bash
omp config set memory-mode off
```
