# oh-my-copilot

Phase 1 MVP for projecting provider-neutral `.agents/skills` into Copilot-friendly command surfaces.

## Scope

- `.agents/skills` remains the canonical source of skill text.
- This package owns catalogs, linting, dry-run projection, Jira payload rendering, docs, and tests.
- `/team` and `/ralph` are thin capability handoff commands in Phase 1, not full Copilot-native runtimes.

## Commands

```bash
npm install
npm run build
npm test
npm run lint:skills
npm run sync:dry-run
npm run jira:dry-run
```
