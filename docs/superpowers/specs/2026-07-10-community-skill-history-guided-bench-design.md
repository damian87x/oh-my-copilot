# Community Skill History and Guided Benchmark Design

## Superseded status

This design has been updated for the dynamic `omp skill-bench` workflow. Historical
references to a packaged benchmark harness, implementation-language-specific runner
commands, and fixed task identifiers are obsolete and must not be revived.

The current goal is still to ship a community-safe `/history-analyze` skill backed by
`omp history analyze`, with an explicitly confirmed handoff into `/skill-bench` for a
discovered skill, explicit skill name, or explicit skill path. The handoff target is
the dynamic `omp skill-bench` design flow, not a fixed task map or package-internal
runner.

## Product contract

- `omp history analyze` defaults to `--window 30d --project all`.
- Accepted windows are `7d`, `30d`, `90d`, and `all`; project scopes are `current` and
  `all`.
- Only `tool.execution_start` events with `data.toolName === "skill"` and a non-empty
  `data.arguments.skill` string count as invocations.
- `session.skills_loaded`, prompt text, assistant text, inferred slash commands, and
  general tool mentions never count.
- Counts are exact for readable matching events. Tokens, AI credits, duration, model
  metrics, and other shutdown telemetry are session-level context only; they are never
  divided among skills or represented as exact per-skill usage.
- `/history-analyze` does not paste raw JSON. It renders a concise human summary,
  ranks observed skill usage as history evidence, and offers both a selected direct
  `/skill-bench` command and an adjustable guided command without starting either.
- Refusal, ambiguity, analyzer failure, empty history, or unavailable handoff stops
  without live benchmark cells and prints the valid guided and direct commands.
- Bare `/skill-bench` runs history-guided dynamic discovery by default, lets the user
  change window/scope or choose an explicit skill/path, and starts no live cells until
  the dynamic design, approval, freeze, and budget gates are satisfied.
- `/skill-bench <skill-or-path>` skips history ranking but uses the same dynamic
  design, approval, freeze, budget, pilot, report, apply, and export flow.
- History-ranked skills, discovered models, execution profiles, and budget values are
  recommendations only. Explicit skill paths and safe explicit model IDs remain valid
  even when they were not observed in history or present in a built-in catalog.
- Model probing is a separate explicit choice because it can consume provider requests.
  Only supplied model IDs are probed; available, unavailable, and unknown stay distinct.
- The conversation advances one decision at a time: select history-guided or direct
  mode, select the skill identity, approve scenarios, approve action contracts, approve
  baseline/reference/rubric/models/profile/budget, freeze, confirm spend, run pilot or
  validated execution, inspect the report, then choose apply/export separately.
- `omp skill-bench run` accepts only a frozen spec ID or safe spec path. Draft import,
  gate approval, and freeze are performed through `omp skill-bench resume`.

## Architecture

### `src/history/analyze.ts`: deterministic library

This module owns filesystem discovery, defensive JSONL parsing, event classification,
filtering, aggregation, warnings, and stable sorting. It exports a pure-enough API with
injectable inputs:

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
`isValidSessionId()` rule, and reads only `<session>/events.jsonl`. Parsing is
line-by-line and defensive. A malformed line increments coverage counters and emits a
warning but does not discard valid lines in the same file.

Session time is the timestamp on `session.start`; if absent or invalid, the analyzer may
use the event-file mtime only for window inclusion and must emit
`missing_session_start`. For `project current`, a session matches only when
`session.start.data.context.cwd` resolves to the same path as the requested cwd. Missing
cwd excludes that session and produces a coverage warning. This is an exact scope
filter, not prefix matching, so sibling and parent projects cannot bleed together.

### `src/commands/history.ts`: registered CLI adapter

Add a `CommandModule` named `history`, registered in `src/commands/registry.ts`. Its
supported grammar is:

```text
omp history analyze [--window 7d|30d|90d|all] [--project current|all] [--json]
```

The adapter validates arguments, supplies defaults, calls `analyzeHistory()`, returns
the schema under `CliResult.output` for JSON, and renders a deterministic table plus
warnings for text mode. It performs no prompt inference and does not invoke Copilot or
benchmark processes.

### Bundled skills

Create `.github/skills/history-analyze/SKILL.md`. It calls
`omp history analyze --json` with only the two documented filters, preserves warnings,
explains that usage is session-level, and never opens or summarizes conversation
content. JSON is an internal transport and is never pasted to the user. Instead, the
skill presents:

1. The requested window and project scope.
2. Ranked observed skills with dynamic discovery/provenance context and any ambiguous
   or unresolved identities shown separately.
3. Exact session-level token, premium-request, AI-credit, duration, and per-metric
   coverage values.
4. Single-skill associations, the shared-skill bucket, and every analyzer warning.

When history evidence identifies a plausible candidate, show the exact direct and guided
`/skill-bench` commands. Do not ask for consent and do not duplicate benchmark execution
inside `/history-analyze`; invoking either offered command starts a separate dynamic
pair-design. No live benchmark cell may start before the user-approved design, freeze,
budget, and spend-confirmation gates.

Modify `.github/skills/skill-bench/SKILL.md` as the community-facing conversation
contract:

1. For bare `/skill-bench`, run history-guided discovery with default `30d/all`, show
   candidates as evidence, and let the user change filters or choose any explicit
   skill/path.
2. For `/skill-bench <skill-or-path>`, enter direct design for that exact skill
   identity/path without a fixed menu.
3. Ask one unresolved decision at a time and require user/domain-expert approval for
   selection, scenarios, action contract, reference package, rubric, models/judges,
   execution profile, and budget gates.
4. Use `omp skill-bench resume <draft-id> --import <manifest.json>`,
   `--approve <gate>`, and `--freeze` for reviewed manifest import, approvals, and
   spec freeze.
5. After freeze, ask for explicit spend confirmation, then record that hash-bound
   confirmation with `omp skill-bench run <spec-id-or-path> --pilot|--validated
   --approve-spend`. Without the flag, live provider cells remain blocked.
6. After the run, report first; offer `apply` and `export` as separate explicit
   choices. Dry-run apply before mutation. Preview export without `--approve`, show its
   exact file/hash/redaction plan, then require explicit approval for the second call.
7. On refusal, ambiguity, empty history, analyzer failure, unavailable runner, failed
   approval, failed freeze, or missing spend confirmation, stop without starting live
   cells and show the valid guided/direct/resume commands.

Unknown explicit arguments retain the direct dynamic-resolution behavior: resolve the
provided skill name or path, or stop with clear guidance when the identity is ambiguous
or unavailable.

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
      "lastInvokedAt": "2026-07-09T14:30:00.000Z"
    },
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

For `window: "all"`, `filters.since` is `null`. Skill rows sort by invocations
descending, sessions descending, last invocation descending, then skill name ascending.
Numeric shutdown totals include only finite non-negative values; absent categories remain
absent from `totals` rather than becoming zero. The analyzer may sum session telemetry for skill-invoking sessions only,
retaining only the final cumulative shutdown snapshot. The fixed `attribution` string
and presentation must make clear those totals cover whole skill sessions. Single-skill
rows are associations, not per-invocation attribution; multi-skill telemetry exists only
in the shared bucket and is never split or copied. `totalTokens` is derived only when
all four token categories are present.
Every usage bucket includes `metricSessions`; each optional numeric total reports
exactly how many shutdown telemetry sessions contributed to that metric. Missing and
incomplete shutdown telemetry for skill sessions are coalesced warnings, and decimal
request totals are emitted without binary floating-point noise.

## Error and warning contract

Fatal CLI errors return `ok: false`, exit code `1`, and no partial JSON report:

- unknown subcommand: `history supports only: analyze`
- invalid/missing flag value: list the accepted values
- repeated conflicting flag: identify the flag
- session-state path exists but is not a directory

A missing session-state directory is a successful empty report with
`sessionsDiscovered: 0` and a `session_state_missing` warning. Unreadable session
directories/files, malformed JSONL, invalid session IDs, missing start cwd/time, and
malformed shutdown telemetry are non-fatal coverage warnings. Warnings are stable
`{code,count,message}` rows, coalesced by code and sorted by code.

## Privacy and safety

- The analyzer inspects only event type and the minimum structured fields needed for
  start cwd, skill tool arguments, timestamps, and shutdown telemetry.
- It must not access `user.message`, `assistant.message`, `data.content`, `tool output`,
  or prompt fields, and must not serialize raw events.
- Session IDs and individual paths are not emitted. The requested cwd is emitted only
  because the caller supplied it; text output may display it only for `project=current`.
- The deterministic CLI analyzer makes no network calls, model calls, subprocesses, or
  writes. The skill's Copilot turn and explicit benchmark handoff remain outside that
  analyzer boundary.
- No benchmark subprocess starts without explicit direct-mode consent or completion of
  the dynamic `/history-analyze` or bare `/skill-bench` handoff plus design/freeze/budget gates.

## Non-goals

- Prompt-based skill detection or slash-command inference.
- Exact per-skill tokens, cost, AI credits, model usage, or duration.
- Maintaining a fixed benchmark eligibility list or static skill-to-task map.
- Copying the project-local MoltCore history skill or coupling the analyzer to that
  workspace.
- Changing benchmark arms, models, repetitions, workers, scoring, `check`, or `latest`.
- Restoring the removed packaged harness or documenting package-internal runner commands.

## Verification additions for the interactive history entry point

- A bundled-skill contract test fails unless raw JSON is hidden, the human summary is
  required, no fixed supported-skill menu appears, and affirmative handoff uses
  `/skill-bench` dynamic design mode.
- A fresh Copilot session runs default `/history-analyze` (`30d all`), records the
  normalized history analyzer command, and answers No to the inline handoff question.
- The refusal smoke must contain the exact normalized history command, no benchmark
  invocation, no direct runner command, and no new run artifact.
- The deterministic CLI JSON contract remains stable and continues to serve scripts and
  tests.
