# Skill retro report template

Fill from `omp history analyze` JSON or reuse the CLI markdown output.

## Rules

- Copy numbers exactly (no rounding).
- Session-level spend only — never per-skill $.
- Preserve every warning verbatim.
- Never paste raw JSON to the user.

## Template

```markdown
## Skill retro (WINDOW, project=SCOPE)

### Window & coverage

| Field | Value |
| --- | --- |
| Window | filters.window |
| Project | filters.project |
| Since | filters.since |
| Sessions matched / discovered | coverage.sessionsMatched / coverage.sessionsDiscovered |
| Sessions with skill invocations | coverage.sessionsWithInvocations |
| Invocations counted | coverage.invocationsCounted |
| Skill sessions with telemetry | coverage.shutdownTelemetrySessions |

### Top skills

| # | Skill | Invocations | Sessions | Last invoked |
| --- | --- | --- | --- | --- |
| 1 | skills[i].skill | skills[i].invocations | skills[i].sessions | skills[i].lastInvokedAt |

### Session-level usage

_Attribution: **session-level-only** — not per-skill._

Skill sessions: **sessionUsage.sessions** (sessionUsage.sessionsWithTelemetry with telemetry)

| Metric | Total | Metric sessions |
| --- | --- | --- |
| Input tokens | totals.inputTokens | metricSessions.inputTokens |
| Cached input tokens | totals.cachedInputTokens | … |
| Cache write tokens | totals.cacheWriteTokens | … |
| Output tokens | totals.outputTokens | … |
| Total tokens | totals.totalTokens | … |
| AI credits (nano-AIU) | totals.totalNanoAiu | … |
| Premium requests | totals.premiumRequests | … |
| API duration (ms) | totals.durationMs | … |

### Spend estimates

| Field | Value |
| --- | --- |
| Source | estimates.source |
| AI credits | estimates.aiCredits |
| Estimated USD (from credits) | estimates.estimatedUsdFromCredits |

| Model | nano-AIU | AI credits | USD (credits) | USD (public rates) |
| --- | --- | --- | --- | --- |
| byModel[i].model | … | … | … | … or — |

_estimates.disclaimer_

### Single-skill associations

| Skill | Sessions | With telemetry |
| --- | --- | --- |
| singleSkillAssociations[i].skill | … | … |

### Shared skill sessions

Shared: **sharedSkillSessions.sessions** (sharedSkillSessions.sessionsWithTelemetry with telemetry)

### Warnings

| Code | Count | Message |
| --- | --- | --- |
| warnings[i].code | warnings[i].count | warnings[i].message |

### Next steps

- `/history-analyze WINDOW SCOPE`
- `/skill-bench`
- `omp cost`
```
