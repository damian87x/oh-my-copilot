# Worked example: `/teach oh-my-copilot`

Use this when the topic is **oh-my-copilot itself** — onboarding a user to the plugin
and CLI. The sources here are first-party, so skip the web search in step 2 and seed
`RESOURCES.md` directly from this file.

## Seed MISSION.md

```md
# Mission: oh-my-copilot

## Why
Use oh-my-copilot fluently to orchestrate real work — pick the right slash skill for
a task instead of hand-driving Copilot.

## Success looks like
- Run the right skill for a task without checking the README (`/ralplan` → `/team`/`/ralph` → `/code-review`).
- Configure goal + memory so sessions start smart (`/goal`, `/daily-log`, self-evolve).
- Drive the CLI (`omp`, `omp council`, `omp schedule`) from the shell.

## Constraints
- Learn by doing in a real repo, short sessions.

## Out of scope
- Contributing to oh-my-copilot internals (hooks, catalog, runtime).
```

## Seed RESOURCES.md

```md
# oh-my-copilot Resources

## Knowledge
- [README](../../../../README.md)
  Capabilities, install, the In-session shortcuts table, pipeline routing. Use for: the canonical map of every skill.
- [docs/general-skills.md](../../../../docs/general-skills.md)
  Slash-skill layout, capability IDs, portability rules. Use for: how skills are defined and discovered.
- [docs/self-evolve.md](../../../../docs/self-evolve.md)
  The learning loop. Use for: how sessions get smarter over time.
- [docs/copilot-distribution.md](../../../../docs/copilot-distribution.md)
  Project/user skill installs. Use for: where skills live and how they ship.
- The skills themselves: `.github/skills/<name>/SKILL.md`
  The authoritative behaviour of each skill. Use for: exact triggers and rules.

## Wisdom (Communities)
- The repo issues / discussions
  Use for: real workflows, edge cases, what maintainers recommend.
```

## Suggested lesson arc

1. The two halves — shell `omp` CLI vs in-session `/skills` (and why they share state).
2. The default pipeline — `/research-codebase` → `/ralplan` → `/team`/`/ralph`/`/ultrawork` → `/code-review` → `/ultraqa`.
3. Memory & goals — `/goal`, `/daily-log`, self-evolve; how the next session starts smarter.
4. Picking a skill — quiz: given a task, name the skill. Source every answer to the README row.

Cite every claim with a link to the README row or the skill's `SKILL.md`, exactly as
the core teaching rules require.
