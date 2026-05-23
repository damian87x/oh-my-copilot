# Self-evolve loop

A two-file mechanism that turns repeated user corrections into draft project skills.

- `AGENTS.md` instructs the agent to invoke `/self-evolve` before ending a session.
- `.github/skills/self-evolve/SKILL.md` is the loop itself: log corrections to `.oh-my-copilot/self-evolve/log.md`, count repeats per topic, and when a topic recurs three times draft `.github/skills/learned-<slug>/SKILL.md` (flat, top-level, dir name equals frontmatter `name`) with `status: draft`.

## Promoting a draft

Open the drafted `SKILL.md` and delete the `status: draft` line in the frontmatter. The skill becomes a normal project skill on the next Copilot session.

## Pruning

`.oh-my-copilot/self-evolve/log.md` is the source of truth and is committed. Delete or edit lines to reset the counter for a given topic.

## Why agent-driven, not a CLI

Copilot CLI exposes no user-installable hook surface. The cheapest reliable trigger is the agent itself: `AGENTS.md` is loaded into every session, and the instruction there ensures `/self-evolve` runs at wrap-up without any binary, dependency, or shell modification.
