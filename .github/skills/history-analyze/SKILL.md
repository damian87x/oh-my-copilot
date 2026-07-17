---
name: history-analyze
description: Analyze actual local Copilot skill activations without reading conversation content.
---

# History Analyze

Use `/history-analyze` to request this local metadata-only history report.

Resolve the filters before execution. Accepted windows are `7d`, `30d`, `90d`, and `all`, either
positionally or through `--window`/`--since`; accepted project scopes are `current` and `all`, either
positionally or through `--project`. Expand omitted filters to the defaults `30d` and `all`.

Run exactly one normalized command, in this stable option order:

```bash
omp history analyze --window WINDOW --project SCOPE --json
```

Replace `WINDOW` and `SCOPE` with the resolved values. Never run the shorthand command after normalization.

Counts come only from actual `skill` tool execution-start events; never read conversation content,
prompt text, assistant text, or tool output, and never infer invocations from mentions. Preserve every warning
from the command. Usage attribution is `session-level-only`: never describe token, duration, AI-credit,
or model totals as per-skill values.

Usage totals cover skill sessions only. Present single-skill associations separately from the one shared-skill
bucket; never split or copy shared telemetry. Do not inspect session files directly.
Every numeric usage total includes `metricSessions`, the number of telemetry sessions that contributed
that specific metric; do not substitute the broader `sessionsWithTelemetry` count.

## Present the history

Require a successful schema-version-1 report before presentation. Present the history only after a
successful schema-version-1 report. On schema or analyzer failure, stop without presenting history.

Do not print or paste raw JSON. Make the summary decision first: put the selected candidate from the
top-level `skills` array first, before supporting detail. The `skills` array ranks arbitrary observed skills from metadata only; it does not imply a supported benchmark, a semantic task, or failure cause.
Metadata-only history may rank observed skills or models, but must not claim semantic task or failure content. Then, within the available space:

- compact the exact normalized filter, coverage, and every present `sessionUsage` value with its matching
  `metricSessions` value;
- present the observed skill ranking compactly in returned order;
- summarize single-skill associations and the shared-skill bucket by exact counts, with only a small
  bounded sample rather than every row; and
- preserve every warning exactly as returned.

Before offering a handoff, use at most 12 compact bullets or lines and at most 2000 characters. Warnings
may exceed the character bound only when necessary to preserve them verbatim; they still must not expose raw
JSON. Omit lower-value detail rather than exceeding either bound. Copy numeric values exactly as returned.
Do not round, abbreviate, rescale, or recalculate numeric values, and do not describe session-level usage
as per-skill cost.

## Offer the next step

Resolve the next-step placeholders from the report and filters. If a candidate exists, Offer `/skill-bench SELECTED_SKILL` for the selected arbitrary skill. Always also Offer `/skill-bench WINDOW SCOPE` for guided discovery using the same filters.

Do not ask a consent question here and do not start a benchmark or live run from this skill. On silence,
empty answer, non-answer, refusal, ambiguity, analyzer failure, or unavailable handoff, stop without starting a live run and print the valid handoff commands.
