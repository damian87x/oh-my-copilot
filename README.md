# oh-my-copilot

Phase 1 MVP for Copilot-compatible project skills and Jira-safe handoff tooling.

`oh-my-copilot` keeps skill behavior in GitHub Copilot's project skill location, validates the capability catalog, reports slash-skill availability, and prepares Jira payloads without requiring live credentials.

## Install (Copilot CLI plugin)

Two commands install all 17 OMC skills as a Copilot CLI plugin:

```bash
copilot plugin marketplace add damian87x/oh-my-copilot
copilot plugin install oh-my-copilot@oh-my-copilot
```

Requires Copilot CLI v1.0.48+. After install, `/omp-autopilot`, `/ralplan`, `/code-review`, `/create-skill`, `/self-evolve`, etc. are available as slash commands in any Copilot CLI session. (The autopilot skill is exposed as `/omp-autopilot` to avoid a name collision with Copilot CLI's built-in `/autopilot` mode toggle.)

Alternative one-command form (will be deprecated by Copilot CLI in a future release):

```bash
copilot plugin install damian87x/oh-my-copilot
```

> The `owner/repo` install form currently shows a deprecation notice; the marketplace path above is preferred. The plugin install still works.

Per-skill install (existing flow, unchanged):

```bash
gh skill install damian87x/oh-my-copilot <skill-name>    # GitHub CLI path
npx tsx src/cli.ts skill install .github/skills/<name>   # repo-native installer
```

## Phase 1 scope

- `.github/skills/<skill>/SKILL.md` is the canonical skill source.
- No `.agents` or `.claude` skill roots are required.
- Skills are lite slash workflows: short Markdown instructions, no bundled scripts, no external runtime assumptions.
- Fetched skills can be moved directly to `.github/skills/<skill>/`; no catalog entry is required for Copilot to read them.
- Core flow: `/codebase-research` -> `/grill-me` if unclear -> `/ralplan` -> `/team`, `/ralph`, or `/ultrawork` -> `/code-review` -> `/verify` or `/ultraqa`.
- Extra lite skills: `/omp-autopilot`, `/jira-ticket`, `/prototype`, `/caveman`, `/debug`, and `/tdd`.
- Catalog `native` support means a Copilot project skill exists; Phase 1 execution skills are instructions, not durable runtimes.
- Migration: use `/grill-me` instead of `/grill`, and `/ultraqa` instead of `/qa`.
- Jira supports create, comment, and safe-update payloads; transition/link operations require discovery or fall back to exact human-action payloads.

## Skill layout

```text
.github/skills/<skill>/SKILL.md # GitHub Copilot project skills
```

This follows the Copilot agent-skills docs: project skills can live in `.github/skills` and are invoked with `/skill-name`.

## Quickstart

```bash
npm install
npm run build
npm test
npm run lint:skills
npm run sync:dry-run
npm run jira:dry-run
npx tsx src/cli.ts skill install .github/skills/create-skill --dry-run
```

Useful local commands:

```bash
npm run catalog:list
npm run check:catalog
npm run project:inspect
npx tsx src/cli.ts jira render ../.omx/plans/oh-my-copilot-general-skills-ralplan-handoff.md
```

## Documentation

- [General skills](docs/general-skills.md) explains the slash-skill layout, capability IDs, and portability rules.
- [Copilot distribution](docs/copilot-distribution.md) explains project/user skill installs and why GitHub App-based Copilot Extensions are not the target.
- [Jira adapter](docs/jira.md) explains configuration discovery, safe operations, dry-runs, and fallback payloads.
