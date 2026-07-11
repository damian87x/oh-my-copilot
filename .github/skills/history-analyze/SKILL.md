---
name: history-analyze
description: Analyze actual local Copilot skill activations without reading conversation content.
---

# History Analyze

Use `/history-analyze` to request this local report.

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

Require a successful schema-version-1 report before presentation or loading `grill-me`.
Present the history only after a successful schema-version-1 report. On schema or analyzer
failure, stop without presenting history or loading `grill-me`.

Do not print or paste raw JSON. Make the summary decision first: put the selected candidate or
winner from the top-level `skills` array first, before supporting detail. Then, within the available space:

- compact the exact normalized filter, coverage, and every present `sessionUsage` value with its matching
  `metricSessions` value;
- present the supported ranking compactly in returned order;
- summarize `unsupportedSkills`, single-skill associations, and the shared-skill bucket by exact counts,
  with only a small bounded sample rather than every row; and
- preserve every warning exactly as returned.

Before the consent question, use at most 12 compact bullets or lines and at most 2000 characters. Warnings
may exceed the character bound only when necessary to preserve them verbatim; they still must not expose raw
JSON. Omit lower-value detail rather than exceeding either bound. Copy numeric values exactly as returned.
Do not round, abbreviate, rescale, or recalculate numeric values, and do not describe session-level usage
as per-skill cost.

## Offer the next step

Define valid recovery forms with placeholders replaced by resolved values:

- direct: `/skill-bench SELECTED_SKILL`;
- guided: `/skill-bench WINDOW SCOPE`.

Never append the candidate to the guided command. The fixed direct supported modes are:

- `/skill-bench code-review`;
- `/skill-bench tdd`;
- `/skill-bench ralplan`.

If the top-level `skills` array is empty, print the resolved guided command and the fixed direct
commands, then stop. Otherwise, select the first ranked entry.

Call the `skill` tool with `skill: "grill-me"`. Do not call `ask_user` before loading it. Ask exactly
one question naming the selected skill and explaining that Yes starts live benchmark cells and uses
model quota.

On refusal, ambiguity, analyzer failure, no supported skill, or unavailable handoff, stop without
loading `skill-bench` and print the valid commands. Silence, empty answer, and non-answer are not
consent; stop in each case.
With a selected candidate, print both resolved direct and guided forms.

Only after an unambiguous affirmative answer, call the `skill` tool with `skill: "skill-bench"` and
follow its direct mode for the selected skill. Do not start any `python3 run.py --task` command before
that answer, and do not duplicate benchmark execution inside this skill.
