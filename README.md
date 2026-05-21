# oh-my-copilot

Phase 1 MVP for projecting provider-neutral `.agents/skills` into Copilot-friendly command surfaces.

`oh-my-copilot` keeps skill behavior in canonical repo-local skills, validates a neutral capability catalog, renders provider-specific wrappers as dry-run output, and prepares Jira payloads without requiring live credentials.

## Phase 1 scope

- Repo-local `.agents/skills` remains the canonical source of skill text.
- This package owns catalogs, linting, dry-run projection, Jira payload rendering, docs, and tests.
- `/grill`, `/grill-me`, `/verify`, `/jira-ticket`, `/code-review`, and `/qa` are projected from canonical or tiny provider-neutral skills.
- `/ralplan`, `/team`, and `/ralph` are capability handoff commands. `/team` and `/ralph` are not full Copilot-native runtimes in Phase 1.
- Jira supports create, comment, and safe-update payloads; transition/link operations require discovery or fall back to exact human-action payloads.

## Skill layout

This repo is self-contained:

```text
.agents/skills/<skill>/SKILL.md     # canonical provider-neutral skills
.claude/skills -> ../.agents/skills # symlink for Claude, not a copy
.github/copilot/...                 # generated Copilot wrappers
```

Do not depend on a parent workspace `.agents` or `.claude` directory.

## Quickstart

```bash
npm install
npm run build
npm test
npm run lint:skills
npm run sync:dry-run
npm run jira:dry-run
```

Useful local commands:

```bash
npm run catalog:list
npm run check:catalog
npm run project:inspect
npx tsx src/cli.ts jira render ../.omx/plans/oh-my-copilot-general-skills-ralplan-handoff.md
```

## Documentation

- [General skills](docs/general-skills.md) explains canonical skills, neutral capability IDs, provider projections, and portability rules.
- [Jira adapter](docs/jira.md) explains configuration discovery, safe operations, dry-runs, and fallback payloads.

## MVP boundary

Adapters may render provider-specific examples such as slash commands, but canonical skill bodies should stay provider-neutral. Generated wrappers should call an existing provider runtime only when one is available; otherwise they must emit a clear unsupported/fallback handoff with enough context for another runtime or human to continue.
