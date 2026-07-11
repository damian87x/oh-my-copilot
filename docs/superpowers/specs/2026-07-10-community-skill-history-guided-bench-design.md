# Community Skill History and Guided Benchmark Design

## Goal

Ship a community-safe `/history-analyze` skill backed by a deterministic `omp history analyze`
command. The skill turns the machine report into a concise human summary and offers one explicitly
confirmed benchmark next step. Bare `/skill-bench` remains a second guided entry point. Existing
`/skill-bench check`, `/skill-bench latest`, and direct
`/skill-bench code-review|tdd|ralplan` behavior remains unchanged.

## Product contract

- `omp history analyze` defaults to `--window 30d --project all`.
- Accepted windows are `7d`, `30d`, `90d`, and `all`; project scopes are `current` and `all`.
- Only `tool.execution_start` events with `data.toolName === "skill"` and a non-empty
  `data.arguments.skill` string count as invocations.
- `session.skills_loaded`, prompt text, assistant text, inferred slash commands, and general tool
  mentions never count.
- Counts are exact for readable matching events. Tokens, AI credits, duration, model metrics, and
  other shutdown telemetry are session-level context only; they are never divided among skills or
  represented as exact per-skill usage.
- `/history-analyze` does not paste raw JSON. It renders a concise human summary, identifies the
  first ranked supported skill when one exists, loads `/grill-me`, and asks exactly one question
  before handing an affirmative answer to the existing direct `/skill-bench` path.
- Refusal, ambiguity, analyzer failure, missing supported history, or unavailable handoff stops
  without live benchmark cells and prints the valid guided and direct commands.
- Bare `/skill-bench` runs history analysis, ranks only `code-review`, `tdd`, and `ralplan`, lists
  observed unsupported skills separately, invokes `/grill-me` for one explicit selection and
  confirmation, and starts no benchmark cells until the user confirms.

## Architecture

### `src/history/analyze.ts`: deterministic library

This module owns filesystem discovery, defensive JSONL parsing, event classification, filtering,
aggregation, warnings, and stable sorting. It exports a pure-enough API with injectable inputs:

```ts
export type HistoryWindow = "7d" | "30d" | "90d" | "all";
export type HistoryProjectScope = "current" | "all";

export interface AnalyzeHistoryOptions {
  window: HistoryWindow;
  project: HistoryProjectScope;
  cwd: string;
  sessionStateDir?: string;
  now?: Date;
}

export interface HistoryAnalysis { /* schema below */ }
export function analyzeHistory(options: AnalyzeHistoryOptions): HistoryAnalysis;
```

It scans immediate directories under `sessionStateDir` (default
`~/.copilot/session-state`), validates every session directory name with the existing
`isValidSessionId()` rule, and reads only `<session>/events.jsonl`. Parsing is line-by-line and
defensive. A malformed line increments coverage counters and emits a warning but does not discard
valid lines in the same file.

Session time is the timestamp on `session.start`; if absent or invalid, the analyzer may use the
event-file mtime only for window inclusion and must emit `missing_session_start`. For `project
current`, a session matches only when `session.start.data.context.cwd` resolves to the same path as
the requested cwd. Missing cwd excludes that session and produces a coverage warning. This is an
exact scope filter, not prefix matching, so sibling and parent projects cannot bleed together.

### `src/commands/history.ts`: registered CLI adapter

Add a `CommandModule` named `history`, registered in `src/commands/registry.ts`. Its supported
grammar is:

```text
omp history analyze [--window 7d|30d|90d|all] [--project current|all] [--json]
```

The adapter validates arguments, supplies defaults, calls `analyzeHistory()`, returns the schema
under `CliResult.output` for JSON, and renders a deterministic table plus warnings for text mode.
It performs no prompt inference and does not invoke Copilot or benchmark processes.

### Bundled skills

Create `.github/skills/history-analyze/SKILL.md`. It calls `omp history analyze --json` with only the
two documented filters, preserves warnings, explains that usage is session-level, and never opens or
summarizes conversation content. JSON is an internal transport and is never pasted to the user.
Instead, the skill presents:

1. The requested window and project scope.
2. Ranked supported skills and observed unsupported skills.
3. Exact session-level token, premium-request, AI-credit, duration, and per-metric coverage values.
4. Single-skill associations, the shared-skill bucket, and every analyzer warning.

When `skills` contains a supported candidate, select its first entry, load `/grill-me` through the
`skill` tool, and ask exactly one question naming that candidate and the fact that continuing starts
live benchmark cells. On an unambiguous affirmative answer, load `/skill-bench` and follow its direct
mode for the selected skill; do not duplicate the benchmark runner inside `/history-analyze`. On any
non-affirmative answer, stop and show the exact guided and direct commands. No `python3 run.py --task`
command may start before the affirmative answer.

Modify `.github/skills/skill-bench/SKILL.md` only at the missing-argument branch:

1. Run `omp history analyze --window 30d --project all --json`.
2. Display benchmarkable skills in report rank order and observed unsupported skills separately.
3. Invoke `/grill-me` to ask exactly one question that names the selected supported skill and
   explicitly asks permission to start live benchmark cells.
4. On affirmative confirmation, dispatch through the existing direct mapping and execution path.
5. On refusal, ambiguity, empty supported history, analyzer failure, or unavailable `/grill-me`,
   stop without starting live cells and show direct modes.

Unknown explicit arguments retain the current mode-list-and-stop behavior. Direct modes are not
forced through history or `/grill-me`; passing one remains consent under the existing contract.

## Locked JSON schema

`omp history analyze --json` emits exactly one JSON value on stdout:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-10T22:02:22.000Z",
  "filters": {
    "window": "30d",
    "project": "all",
    "cwd": "/absolute/invocation/cwd",
    "since": "2026-06-10T22:02:22.000Z"
  },
  "coverage": {
    "sessionsDiscovered": 12,
    "sessionsRead": 11,
    "sessionsMatched": 8,
    "sessionsWithInvocations": 5,
    "filesUnreadable": 1,
    "malformedLines": 3,
    "invocationsCounted": 9,
    "shutdownTelemetrySessions": 4
  },
  "skills": [
    {
      "skill": "code-review",
      "invocations": 4,
      "sessions": 3,
      "lastInvokedAt": "2026-07-09T14:30:00.000Z",
      "benchmarkable": true,
      "benchmarkTask": "code-review-sqli"
    }
  ],
  "unsupportedSkills": [
    {
      "skill": "research-codebase",
      "invocations": 2,
      "sessions": 2,
      "lastInvokedAt": "2026-07-08T10:00:00.000Z"
    }
  ],
  "sessionUsage": {
    "attribution": "session-level-only",
    "sessions": 5,
    "sessionsWithTelemetry": 4,
    "totals": {
      "inputTokens": 1000,
      "cachedInputTokens": 200,
      "cacheWriteTokens": 20,
      "outputTokens": 300,
      "totalTokens": 1520,
      "totalNanoAiu": 4000000000,
      "premiumRequests": 7,
      "durationMs": 50000
    },
    "metricSessions": {
      "inputTokens": 4,
      "cachedInputTokens": 3,
      "cacheWriteTokens": 3,
      "outputTokens": 4,
      "totalTokens": 3,
      "totalNanoAiu": 4,
      "premiumRequests": 2,
      "durationMs": 4
    },
    "singleSkillAssociations": [
      { "skill": "code-review", "sessions": 2, "sessionsWithTelemetry": 2, "totals": { "inputTokens": 500 }, "metricSessions": { "inputTokens": 2 } }
    ],
    "sharedSkillSessions": { "sessions": 1, "sessionsWithTelemetry": 1, "totals": { "inputTokens": 200 }, "metricSessions": { "inputTokens": 1 } }
  },
  "warnings": [
    {
      "code": "malformed_jsonl",
      "count": 3,
      "message": "3 event lines were malformed and skipped; invocation counts cover readable events only."
    }
  ]
}
```

For `window: "all"`, `filters.since` is `null`. Skill rows sort by invocations descending,
sessions descending, last invocation descending, then skill name ascending. Unsupported rows use
the same order. Numeric shutdown totals include only finite non-negative values; absent categories
remain absent from `totals` rather than becoming zero. The analyzer may sum session telemetry for
skill-invoking sessions only, retaining only the final cumulative shutdown snapshot. The fixed
`attribution` string and presentation must make clear those totals cover whole skill sessions.
Single-skill rows are associations, not per-invocation attribution; multi-skill telemetry exists only
in the shared bucket and is never split or copied. `totalTokens` is derived only when all four token
categories are present.
Every usage bucket includes `metricSessions`; each optional numeric total reports exactly how many
shutdown telemetry sessions contributed to that metric. Missing and incomplete shutdown telemetry
for skill sessions are coalesced warnings, and decimal request totals are emitted without binary
floating-point noise.

## Error and warning contract

Fatal CLI errors return `ok: false`, exit code `1`, and no partial JSON report:

- unknown subcommand: `history supports only: analyze`
- invalid/missing flag value: list the accepted values
- repeated conflicting flag: identify the flag
- session-state path exists but is not a directory

A missing session-state directory is a successful empty report with `sessionsDiscovered: 0` and a
`session_state_missing` warning. Unreadable session directories/files, malformed JSONL, invalid
session IDs, missing start cwd/time, and malformed shutdown telemetry are non-fatal coverage
warnings. Warnings are stable `{code,count,message}` rows, coalesced by code and sorted by code.

## Privacy and safety

- The analyzer inspects only event type and the minimum structured fields needed for start cwd,
  skill tool arguments, timestamps, and shutdown telemetry.
- It must not access `user.message`, `assistant.message`, `data.content`, `tool output`, or prompt
  fields, and must not serialize raw events.
- Session IDs and individual paths are not emitted. The requested cwd is emitted only because the
  caller supplied it; text output may display it only for `project=current`.
- The deterministic CLI analyzer makes no network calls, model calls, subprocesses, or writes. The
  skill's Copilot turn and explicit benchmark handoff remain outside that analyzer boundary.
- No benchmark subprocess starts without direct-mode consent or a fresh affirmative answer from
  the `/history-analyze` or bare `/skill-bench` `/grill-me` gate.

## Non-goals

- Prompt-based skill detection or slash-command inference.
- Exact per-skill tokens, cost, AI credits, model usage, or duration.
- Benchmarking skills other than the three current harness mappings.
- Copying the project-local MoltCore history skill or coupling the analyzer to that workspace.
- Changing benchmark arms, models, repetitions, workers, scoring, `check`, or `latest`.

## Verification additions for the interactive history entry point

- A bundled-skill contract test fails unless raw JSON is hidden, the human summary is required,
  `/grill-me` loads before any question, and affirmative handoff uses `/skill-bench` direct mode.
- A fresh Copilot session runs default `/history-analyze` (`30d all`), records `history-analyze` followed by
  `grill-me`, and answers No.
- The refusal smoke must contain the exact normalized history command, no `skill-bench` invocation,
  no `python3 run.py --task` command, and no new benchmark run directory.
- The deterministic CLI JSON contract remains unchanged and continues to serve scripts and tests.
