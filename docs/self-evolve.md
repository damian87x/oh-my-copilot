# Self-evolve loop

A two-file mechanism that turns repeated user corrections into draft project skills.

- `.github/copilot-instructions.md` ships with the plugin and instructs the agent to invoke `/self-evolve` before ending a session — so the trigger fires in every project where the plugin is active, not only inside this repo.
- `.github/skills/self-evolve/SKILL.md` is the loop itself: log corrections to `.oh-my-copilot/self-evolve/log.md`, count repeats per topic, and when a topic recurs three times draft `.oh-my-copilot/self-evolve/drafts/<slug>/SKILL.md` with `status: draft`.

## Why drafts live outside `.github/skills/`

`plugin.json` exposes `.github/skills/` as the active plugin skill root, so anything placed there is auto-loaded as a usable slash command on the next Copilot session. Drafts are written by an LLM from inferred mistake patterns and may misfire; auto-loading them before human review would let a malicious "correction" smuggle in a hostile instruction. Drafts land in `.oh-my-copilot/self-evolve/drafts/` instead — a path Copilot CLI never reads.

## Promoting a draft

Move the draft directory from `.oh-my-copilot/self-evolve/drafts/<slug>/` to `.github/skills/learned-<slug>/`. The frontmatter `name` already matches the new directory name (set to `learned-<slug>` at draft time). Optionally delete the `status: draft` line; the project lint does not require it. On the next Copilot session the skill is loaded as `/learned-<slug>`.

## Pruning

`.oh-my-copilot/self-evolve/log.md` is the source of truth and is committed. Delete or edit lines to reset the counter for a given topic.

## Why agent-driven, not a CLI

Copilot CLI exposes no user-installable hook surface. The cheapest reliable trigger is the agent itself: `.github/copilot-instructions.md` is loaded into every session where the plugin is active, and the instruction there ensures `/self-evolve` runs at wrap-up without any binary, dependency, or shell modification.
