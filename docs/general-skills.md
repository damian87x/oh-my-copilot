# General Skills MVP

The canonical skill source is the repo-local `.github/skills` directory. This is the GitHub Copilot project-skill location, so no `.agents` or `.claude` compatibility layer is needed.

## Canonical lite skills

| Skill | Capability IDs | Purpose |
| --- | --- | --- |
| `/research-codebase` | `research-codebase`, `research.codebase` | Comprehensive codebase research with tiered effort. |
| `/grill-me` | `grill-me`, `planning.challenge` | Ask one sharp clarification question when ambiguity remains. |
| `/ralplan` | `ralplan`, `planning.consensus` | Produce implementation-ready plan, tests, and risks. |
| `/team` | `team`, `execution.parallel` | Split approved work into parallel tmux panes running interactive agents. |
| `/ralph` | `ralph`, `execution.single-owner` | Single-owner execute-fix-verify loop. |
| `/ultrawork` | `ultrawork`, `execution.parallel` | Batch many independent small tasks. |
| `/ultraqa` | `ultraqa`, `qa.behavioral` | Adversarial behavior and regression QA. |
| `/omp-autopilot` | `omp-autopilot`, `execution.autonomous` | Lightweight end-to-end flow across the other skills. (Renamed from `/autopilot` to avoid Copilot CLI built-in collision.) |
| `/code-review` | `code-review`, `review.independent` | Review completed changes before merge or handoff. |
| `/verify` | `verify`, `verification.evidence` | Prove completion claims with evidence. |
| `/jira-ticket` | `jira-ticket`, `tracker.ticket` | Render Jira create/comment/safe-update payloads. |
| `/prototype` | `prototype`, `design.prototype` | Build disposable experiments for design questions. |
| `/caveman` | `caveman`, `communication.compact` | Ultra-compact response mode. |
| `/debug` | `debug`, `debug.systematic` | Reproduce, diagnose, fix, and regression-test bugs. |
| `/tdd` | `tdd`, `testing.tdd` | Red-green-refactor for behavior changes. |
| `/worktree` | `worktree`, `workflow.worktree` | Git worktree-based parallel branch work. |

## Repo-local layout

```text
oh-my-copilot/
  .github/skills/<skill>/SKILL.md # Copilot project skill source of truth
```

Rules:

- Edit `.github/skills/*/SKILL.md` first.
- Use `/skill-name` invocation language.
- Do not create `.agents` or `.claude` skill roots in this repo.
- Do not generate `.github/copilot/...` wrappers; Copilot reads project skills directly.
- Keep each `SKILL.md` small: YAML frontmatter (`name`, `description`) plus focused Markdown instructions.
- Optional `references/`, `scripts/`, or `assets/` may live beside `SKILL.md` when a fetched skill needs progressive disclosure.
- Do not add runtime state to the lite skills.

## Fetched skills

Skills fetched in the common `skills/<name>/SKILL.md` package shape can be moved directly to `.github/skills/<name>/SKILL.md`.
The catalog is optional metadata for the built-in general skill list; Copilot discovery uses `.github/skills` itself.

## Capability semantics

`providerSupport.copilot.state = native` means Copilot can read the repo-local slash skill from `.github/skills`.
It does not imply a durable execution runtime. Phase 1 execution skills such as `/team`, `/ralph`, `/ultrawork`, and `/omc-autopilot` are plain project-skill instructions, not persisted runtimes.

## Phase 1 flow

```text
/research-codebase
  -> /grill-me when unclear or risky
  -> /ralplan
  -> /team if lanes are independent, otherwise /ralph or /ultrawork
  -> /code-review
  -> /verify or /ultraqa
  -> /jira-ticket when tracking is requested
```

## Portability rules

Canonical `.github/skills/*/SKILL.md` bodies should avoid runtime coupling:

- Do not require tmux panes, external agent team state, local orchestration state, or GitHub Issues.
- Do not embed secrets or Jira credentials.
- Do not use `$skill` invocation syntax in Copilot project skills.
- Prefer slash-skill language and plain Markdown instructions over long framework-specific prompt text.

## Migration notes

- `/grill` was folded into `/grill-me` to keep one clarification entrypoint.
- `/qa` was folded into `/ultraqa` for the adversarial QA pass.
