---
name: history-analyze
description: Analyze actual local Copilot skill activations without reading conversation content.
---

# History Analyze

Use `/history-analyze` to request this local report.

Run `omp history analyze --json` and present its deterministic report. Accepted windows are `7d`, `30d`,
`90d`, and `all`, either positionally or through `--window`/`--since`; accepted project scopes are
`current` and `all`, either positionally or through `--project`. Defaults are `30d` and `all`.
Normalize the requested filters into the JSON command. Examples:

```bash
omp history analyze --json
omp history analyze --window 7d --project current --json
```

Counts come only from actual `skill` tool execution-start events. You must never read conversation content,
prompt text, assistant text, or tool output, and never infer invocations from mentions. Always preserve every warning
from the command. Usage attribution is `session-level-only`: never describe token, duration,
AI-credit, or model totals as per-skill values.

Usage totals cover skill sessions only. Present single-skill associations separately from the one shared-skill
bucket; never split or copy shared telemetry. Do not inspect session files directly.
Every numeric usage total includes `metricSessions`, the number of telemetry sessions that contributed
that specific metric; do not substitute the broader `sessionsWithTelemetry` count.
Copy every count and usage value exactly as returned. Do not round, abbreviate, rescale, or recalculate numeric values.
Return only the requested history report; do not review directives, memories, transcripts, or unrelated workspace state.
