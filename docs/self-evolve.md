# Self-evolve loop

A mechanism that turns repeated user corrections and observed routines into draft project skills. Detection now runs on two tracks:

- **Automated (memory-mode):** every reviewed session's transcript is scanned by the memory-review model, which emits `skill_drafts` for reusable procedures it observed. The review is told which drafts and promoted skills already exist and `applyReview` skips known slugs, so routines are only drafted once — never duplicated. Promotion stays human-gated.
- **Agent-driven (`/self-evolve`):** the in-session skill below still counts explicit corrections per topic and drafts after three repeats.

- `.github/copilot-instructions.md` ships with the plugin and instructs the agent to invoke `/self-evolve` before ending a session — so the trigger fires in every project where the plugin is active, not only inside this repo.
- `.github/skills/self-evolve/SKILL.md` is the loop itself: log corrections to `.omp/self-evolve/log.md`, count repeats per topic, and when a topic recurs three times draft `.omp/self-evolve/drafts/<slug>/SKILL.md` with `status: draft`.

## Why drafts live outside `.github/skills/`

`plugin.json` exposes `.github/skills/` as the active plugin skill root, so anything placed there is auto-loaded as a usable slash command on the next Copilot session. Drafts are written by an LLM from inferred mistake patterns and may misfire; auto-loading them before human review would let a malicious "correction" smuggle in a hostile instruction. Drafts land in `.omp/self-evolve/drafts/` instead — a path Copilot CLI never reads.

## Promoting a draft

Move the draft directory from `.omp/self-evolve/drafts/<slug>/` to `.github/skills/learned-<slug>/`. The frontmatter `name` already matches the new directory name (set to `learned-<slug>` at draft time). Optionally delete the `status: draft` line; the project lint does not require it. On the next Copilot session the skill is loaded as `/learned-<slug>`.

## Pruning

`.omp/self-evolve/log.md` is the source of truth. It lives inside the gitignored `.omp/` state directory, so it is local to the machine, not committed. Delete or edit lines to reset the counter for a given topic.

## Migration from `.oh-my-copilot/`

Older omp versions kept the ledger and drafts under `.oh-my-copilot/self-evolve/`. The next memory review moves that directory under `.omp/` automatically; `/self-evolve` also does the move if it finds the legacy path.

## Why agent-driven, not a CLI

Copilot CLI exposes no user-installable hook surface. The cheapest reliable trigger is the agent itself: `.github/copilot-instructions.md` is loaded into every session where the plugin is active, and the instruction there ensures `/self-evolve` runs at wrap-up without any binary, dependency, or shell modification.
