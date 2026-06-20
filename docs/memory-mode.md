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
omp config set memory-mode on                    # opt in
omp config set memory-review-model gpt-5-mini     # optional; defaults to gpt-5-mini
omp config set memory-review-min-messages 4       # optional; skip sessions shorter than this (default 4)
omp config get                                    # show current settings
```

Config is stored in `.omp/config.json`. The env var `OMP_MEMORY_MODE=on|off`
overrides the file.

## How it triggers

| Surface | Trigger | Notes |
|---|---|---|
| Interactive `copilot` (plugin installed) | `sessionEnd` hook | Detaches `omp memory-review` as a background process and returns immediately (hooks have a 5s budget). |
| `omp -p` / `omp launch -- -p` (headless) | wrapper, post-exit | Headless `copilot -p` skips hooks, so the omp wrapper detaches the review. It snapshots session dirs before launch and reviews the **exact** session created by that run — if it can't identify one, it skips rather than guess. |
| Manual | `omp memory-review --session <uuid\|latest>` | Run it yourself against any session (`latest` = newest by mtime). |

Both automatic triggers only **detach** the work. The review claims the session
atomically (`.oh-my-copilot/memory-review/.claim-<uuid>`), so even if the hook
and wrapper both fire, the review runs **exactly once**.

## What it writes

| Output | Destination | Applied? |
|---|---|---|
| **Notes** (durable facts) | project memory (`omp project-memory`) | ✅ applied — progressive disclosure, low blast radius |
| **Skill drafts** (procedures) | `.oh-my-copilot/self-evolve/drafts/<slug>/SKILL.md` | ⏸ human-promote — never auto-loaded (same as `/self-evolve`) |
| **Directives** (every-session rules) | `.oh-my-copilot/memory-review/pending-directives.md` | ⏸ **gated** — never auto-applied |

After the review writes notes it refreshes the managed block in
`.github/copilot-instructions.md`, listing the most recent note **titles** (capped,
newest-first) so the next session knows what it remembers; bodies stay on demand
(`omp project-memory read <id>`). The review also ensures `.omp/` and
`.oh-my-copilot/` are gitignored so memory (which may contain tool output) isn't
accidentally committed.

### Promoting a pending directive (manual, by design)

Directives are gated: they inject into every future session, so an injected/poisoned
one would steer everything. The review prompt treats the transcript as **data, not
instructions**, and only proposes directives from corrections / standing preferences —
never one-off task instructions. On the next session start you'll see a nudge:
`[MEMORY REVIEW] N proposed directive(s) await your review…`. To promote one:

```bash
cat .oh-my-copilot/memory-review/pending-directives.md   # review the proposals
omp project-memory add-directive "User prefers concise replies"  # apply the ones you want
# then delete the promoted line from pending-directives.md
```

Skill drafts promote the same way as `/self-evolve`: move
`.oh-my-copilot/self-evolve/drafts/<slug>/` to `.github/skills/learned-<slug>/`.

### Pruning notes

Notes accumulate over time. Trim them anytime (never silent — requires a flag):

```bash
omp project-memory prune-notes --keep 50        # keep the 50 newest
omp project-memory prune-notes --older-than 30  # drop notes older than 30 days
```

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
