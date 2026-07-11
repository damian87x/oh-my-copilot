# PRD: Community Skill History and Guided Benchmarking

## Outcome

Any local Copilot CLI user who installs OMP can see a deterministic, privacy-preserving summary of
actual skill activations and can use bare `/skill-bench` to select a currently supported benchmark
without accidental live spend.

## Users and jobs

- A community user wants to know which skills were actually invoked recently across all projects
  or in the current project.
- A maintainer wants exact activation counts while being honest that cost and tokens are available
  only for entire sessions.
- A user who enters bare `/skill-bench` wants a guided choice based on their history, but wants a
  confirmation boundary before real benchmark cells execute.

## Functional requirements

### Usage telemetry correction

Only the final cumulative `session.shutdown` snapshot is retained per session, using a typed optional
usage schema. Only sessions with actual skill tool starts contribute. Single-skill associations and one
non-overlapping shared-skill bucket partition skill sessions; shared telemetry is never split or copied.
All available token categories, strictly-derived total tokens, nano AIU, premium requests, and duration
are emitted in JSON and text. History accepts positional windows/scopes plus `--window`, `--since`, and
`--project`; guided skill-bench accepts the same filters without changing direct modes or confirmation.

### FR1 — deterministic history command

`omp history analyze [--window 7d|30d|90d|all] [--project current|all] [--json]` is registered via
the command registry. Defaults are `30d` and `all`. Output follows schema version 1 in the design
document and uses stable ordering for identical inputs and injected time.

### FR2 — exact event classification

An invocation is counted if and only if an event is `tool.execution_start`, its tool name is
exactly `skill`, and `arguments.skill` is a non-empty string. Loaded-skill inventories, prompts,
assistant messages, tool output, inferred commands, and partial name matches are excluded.

### FR3 — filters

The window uses the session start timestamp, with a warned file-mtime fallback when unavailable.
`current` requires exact resolved-cwd equality with the CLI invocation cwd. `all` accepts every
project. Boundary timestamps are inclusive.

### FR4 — honest coverage and usage

The report exposes sessions discovered/read/matched, malformed lines, unreadable files, exact
invocations counted, and shutdown telemetry coverage. Session shutdown metrics may be aggregated
only as `session-level-only`; OMP never allocates, averages, or divides them across skills.
Missing categories remain missing and produce warnings when they limit interpretation.

### FR5 — distributable history skill

`.github/skills/history-analyze/SKILL.md` ships through normal `omp setup`, invokes the registered
command, preserves filters/warnings, and states the privacy and attribution limits.

### FR6 — guided bare skill-bench

Bare `/skill-bench` runs the default history command, ranks only the current mappings
`code-review`, `tdd`, and `ralplan`, lists observed unsupported skills, then invokes `/grill-me` for
one explicit selection-and-live-run confirmation. Only an affirmative answer proceeds through the
existing direct execution path. Empty history, no supported history, refusal, ambiguity, history
failure, or missing grill capability stops before live cells.

### FR7 — backward compatibility

`/skill-bench check`, `/skill-bench latest`, and explicit `/skill-bench
code-review|tdd|ralplan` retain their current mappings, defaults, selftest, execution, report-open,
and presentation behavior. Unknown explicit arguments still show supported modes and stop.

## Acceptance criteria

1. CLI help lists the exact history grammar, and registry/CLI tests prove dispatch works in text
   and JSON modes.
2. Fixture tests prove only actual `skill` tool-start events count and specifically prove
   `session.skills_loaded`, prompt mentions, assistant mentions, wrong tool names, malformed
   arguments, and tool completion events do not count.
3. Default output is byte-for-byte equivalent to explicit `--window 30d --project all` after
   normalizing `generatedAt` through injected time.
4. All four windows and both project scopes have boundary, invalid-value, empty, missing-cwd, and
   malformed-session coverage.
5. JSON output validates against the locked schema, stable sort rules, omission rules, and warning
   coalescing. Text output contains the same counts and the attribution warning.
6. Tests prove shutdown totals are session-level only and no implementation divides telemetry by
   skill or invocation count.
7. Privacy tests with sentinel prompt/assistant secrets prove those fields never appear in output
   and are not required for classification.
8. The bundled history skill passes skill lint and package/setup tests confirm it is included.
9. Skill-bench contract tests prove bare mode calls history then `/grill-me`, does not start live
   work before affirmative confirmation, lists unsupported observations, and maps a confirmed
   supported selection into the unchanged live path.
10. Regression tests prove `check`, `latest`, all three direct modes, and unknown-argument handling
    are unchanged.
11. Build, focused tests, full tests, ESLint, skill lint, catalog validation, safety scan, Python
    benchmark tests/selftest, and npm package dry-run pass.

## Failure behavior

- Invalid CLI grammar fails with exit code 1 and actionable accepted values.
- Missing history root succeeds with an empty warned report.
- Unreadable or malformed individual sessions degrade to counted readable coverage plus warnings.
- No history failure is converted into permission to benchmark.
- A non-interactive bare skill-bench cannot synthesize confirmation and must stop.

## Constraints

- Local-only and no prompt/assistant content reads.
- No new dependency.
- Use existing session-ID safety and command registry patterns.
- Surgical changes; no benchmark engine redesign.
- TDD: observe every new focused test fail before implementation.

## Out of scope

- New benchmark tasks or auto-generated benchmark scenarios.
- Per-skill financial attribution.
- Cloud history, telemetry upload, dashboards, or persistent indexes.
- Automatic benchmark execution based only on historical rank.

## Release/stop gate

Implementation is complete only when every acceptance criterion has fresh evidence and a fresh
Copilot session installed through plain `omp setup` discovers both skills. Any live smoke requires
explicit human confirmation; otherwise verification stops at deterministic checks and documents
the skipped live run.
