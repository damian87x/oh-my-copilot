# General Skills MVP

The canonical skill source is the repo-local `.agents/skills` directory. `oh-my-copilot` reads catalog metadata and renders provider-specific invocation surfaces without editing canonical skill bodies.

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

The repo is self-contained. Do not point canonical skills at a parent workspace directory.

```text
oh-my-copilot/
  .agents/skills/<skill>/SKILL.md   # canonical source of truth
  .claude/skills -> ../.agents/skills # symlink, no copied Claude fork
  .github/copilot/...               # generated provider wrappers only
```

Rules:

- Edit `.agents/skills/*/SKILL.md` first.
- Keep `.claude/skills` as a symlink to `../.agents/skills`.
- Do not create workspace-level `.agents` or `.claude` dependencies for this repo.
- Provider-specific wrappers may reference/embed canonical skill text, but must not become source of truth.

## Provider projections

Provider-specific command syntax belongs in docs and generated wrappers, not in canonical skill text.

| Capability | Codex/OMX example | Copilot/Claude-style example |
| --- | --- | --- |
| `planning.challenge` | `$grill` | `/grill` |
| `planning.consensus` | `$ralplan` | `/ralplan` |
| `tracker.ticket` | `$jira-ticket` | `/jira-ticket` |
| `execution.parallel` | `$team` | `/team` fallback handoff when no runtime exists |
| `execution.single-owner` | `$ralph` | `/ralph` fallback handoff when no runtime exists |
| `review.independent` | `$code-review` | `/code-review` |
| `qa.behavioral` | `$qa` | `/qa` |

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

`team` and `ralph` are projection surfaces only in this MVP. A generated wrapper should either call an existing provider runtime or emit an explicit fallback handoff with context, lanes, risks, and verification checklist.

## Portability rules

Canonical `.agents/skills/*/SKILL.md` bodies should avoid provider/runtime coupling:

- Do not require tmux panes, `.omx` state, Claude teams, Codex goal tools, or GitHub Issues.
- Do not embed secrets or Jira credentials.
- Do not make provider command syntax the only source of truth.
- Use neutral capability names in metadata and let adapters render `$...` or `/...` examples.
