# General Skills MVP

The canonical skill source is the repo-local `.github/skills` directory. This is the GitHub Copilot project-skill location, so no `.agents` or `.claude` compatibility layer is needed.

## Canonical skills

| Skill | Capability IDs | Purpose |
| --- | --- | --- |
| `grill` | `grill`, `research.codebase`, `planning.challenge` | Research local context, then ask one unresolved decision question at a time. |
| `grill-me` | alias for `grill` | Backwards-compatible entrypoint that delegates to canonical `grill`. |
| `verify` | `verify` | Collect command evidence, classify PASS/FAIL, and state known gaps. |
| `jira-ticket` | `jira-ticket`, `tracker.ticket` | Render or apply Jira create/comment/safe-update operations with fallback payloads. |
| `code-review` | `code-review`, `review.independent` | Portable non-author review contract. |
| `qa` | `qa`, `qa.behavioral` | Behavior-focused QA evidence gate. |
| `ralplan` | `ralplan`, `planning.consensus` | Consensus planning handoff. |
| `team` | `team`, `execution.parallel` | Thin parallel-execution handoff. |
| `ralph` | `ralph`, `execution.single-owner` | Thin single-owner execution handoff. |

## Repo-local layout

```text
oh-my-copilot/
  .github/skills/<skill>/SKILL.md # Copilot project skill source of truth
```

Rules:

- Edit `.github/skills/*/SKILL.md` first.
- Do not create `.agents` or `.claude` skill roots in this repo.
- Do not generate `.github/copilot/...` wrappers; Copilot reads project skills directly.
- Keep each `SKILL.md` small: YAML frontmatter (`name`, `description`) plus focused Markdown instructions.

## Phase 1 flow

```text
research.codebase
  -> planning.challenge when unclear or risky
  -> planning.consensus
  -> tracker.ticket when work tracking is requested
  -> execution.parallel if lanes are independent, otherwise execution.single-owner
  -> review.independent
  -> qa.behavioral
  -> verification evidence
```

`team` and `ralph` are thin handoff skills only in this MVP. They should call an available runtime when one exists; otherwise they produce an unsupported handoff with context, lanes, risks, and verification checklist.

## Portability rules

Canonical `.github/skills/*/SKILL.md` bodies should avoid runtime coupling:

- Do not require tmux panes, `.omx` state, external agent team state, or GitHub Issues.
- Do not embed secrets or Jira credentials.
- Do not make provider command syntax the only source of truth.
- Prefer capability language and plain Markdown instructions over long framework-specific prompt text.
