# oh-my-copilot

Default behaviours installed with this repo. Override per project as needed.

## Approach
- Surface assumptions before coding.
- Prefer the simplest change that satisfies the request.
- Touch only what the task requires.
- Verify success with concrete checks: tests, output, behaviour.

## Validation
- Run tests for code you change.
- Read the diff before committing.
- If unsure about scope, ask.

## Skills
Slash commands under `.github/skills/<name>/SKILL.md` are auto-discovered by Copilot. See `omp list` for the catalog active in this project.

## Hooks
Lifecycle hooks declared in `hooks/hooks.json` invoke scripts in `scripts/`. Run `omp doctor` to verify discovery.
