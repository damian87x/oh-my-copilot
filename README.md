# oh-my-copilot

Phase 1 MVP for Copilot-compatible project skills and Jira-safe handoff tooling.

`oh-my-copilot` keeps skill behavior in GitHub Copilot's project skill location, validates the capability catalog, reports Copilot skill availability, and prepares Jira payloads without requiring live credentials.

## Phase 1 scope

- `.github/skills/<skill>/SKILL.md` is the canonical skill source.
- No `.agents` or `.claude` skill roots are required.
- `/grill`, `/grill-me`, `/verify`, `/jira-ticket`, `/code-review`, `/qa`, `/ralplan`, `/team`, and `/ralph` are Copilot project skills.
- `/team` and `/ralph` remain thin handoff skills, not full durable runtimes in Phase 1.
- Jira supports create, comment, and safe-update payloads; transition/link operations require discovery or fall back to exact human-action payloads.

## Skill layout

```text
.github/skills/<skill>/SKILL.md # GitHub Copilot project skills
```

This follows the Copilot agent-skills docs: project skills can live in `.github/skills`.

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

- [General skills](docs/general-skills.md) explains the Copilot skill layout, capability IDs, and portability rules.
- [Jira adapter](docs/jira.md) explains configuration discovery, safe operations, dry-runs, and fallback payloads.
