# General Skills MVP

The canonical skill source is `.agents/skills`. Provider adapters should translate invocation syntax only:

- Codex/OMX: `$skill-name`
- Copilot/Claude-style projections: `/skill-name`

## Phase 1 flow

```text
research.codebase -> grill -> ralplan -> jira-ticket -> team|ralph -> code-review -> qa -> final evidence
```

`grill` is primary. `grill-me` remains a compatibility alias.

`team` and `ralph` are cataloged as thin handoff surfaces. If a provider runtime exists, the projected command can call it. If not, it should emit a clear unsupported handoff with preserved context.

## MVP skills

- `grill` — ambiguity reduction and design grilling.
- `verify` — evidence-first completion gate.
- `jira-ticket` — Jira create/comment/safe-update payloads with safe fallback.
- `code-review` — non-author review gate; opposite model when available.
- `qa` — portable QA gate and hostile scenario checks.
