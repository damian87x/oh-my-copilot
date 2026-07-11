# Test Specification: Community Skill History and Guided Benchmarking

## Test strategy

### Locked repair regressions

Cover exact window/cwd boundaries, repeated cumulative shutdown replacement, zero-skill exclusion,
single-versus-shared usage partitioning, premium requests and duration mapping, strict total-token
derivation, malformed telemetry, privacy-minimized projection, numeric text/JSON output, positional and
flag command dispatch, guided aliases, setup/package inclusion, and affirmative-confirmation ordering.

Use fixture-first Vitest tests with temporary session-state roots and injected `now`. Keep analyzer
tests free of the real home directory. Lock CLI and Markdown skill contracts separately, retain the
existing Python harness tests, then finish with package and fresh-session smoke checks.

## Unit suite: `test/history/analyze.test.ts`

### Event classification

- Counts one real `tool.execution_start` with `data.toolName: "skill"` and
  `data.arguments.skill: "code-review"`.
- Counts repeated invocations separately and session cardinality once.
- Excludes `session.skills_loaded` even when it lists the same skill.
- Excludes user/assistant prompt sentinels such as `/code-review` and `use tdd`.
- Excludes `tool.execution_complete`, wrong/case-changed tool names, missing/blank/non-string
  skill arguments, and unrelated tools whose arguments mention a skill.
- Accepts valid lines around malformed JSON and reports the exact malformed-line count.

### Filters and discovery

- Default-equivalent explicit fixture covers `30d/all`.
- Parameterized tests cover `7d`, `30d`, `90d`, and `all`, including exactly-on-boundary sessions
  and sessions one millisecond outside.
- `current` includes exact normalized cwd and excludes parent, child, sibling, missing, and invalid
  cwd values; `all` includes every valid project cwd.
- Missing start timestamp uses file mtime, includes/excludes correctly, and warns.
- Invalid session directory names are skipped; path traversal names cannot escape the fixture.
- Missing root returns successful empty coverage and warning; non-directory root is fatal.
- Unreadable files are skipped and warned where platform permissions make the case reliable.

### Aggregation and schema

- Supported rows map exactly to `code-review-sqli`, `tdd-slugify`, and `ralplan-pwreset`.
- Other observed skills appear only in `unsupportedSkills` and remain visible.
- Stable sorting uses invocation count, session count, last invocation, then lexical name.
- `lastInvokedAt`, session count, coverage counters, `generatedAt`, and `since` match fixtures.
- `all` emits `since: null`; missing optional usage totals are omitted, never zero-filled.
- Warnings coalesce by code, have exact counts, and sort lexically by code.

### Session-level usage honesty

- Parses valid shutdown token categories, `totalNanoAiu`, and duration from matched sessions.
- Skips negative, non-finite, string, and malformed metrics with coverage warnings.
- Emits `attribution: "session-level-only"` for non-empty and empty telemetry.
- A fixture with two skills in one session proves totals equal the session shutdown totals, not
  totals divided by two or copied into either skill row.
- Skill rows contain no token, AIU, cost, duration, or model metric fields.

### Privacy

- Prompt, assistant, tool-output, and system-content fields contain unique secrets; serialized and
  formatted reports contain none of them.
- A minimal fixture with those content properties throwing through a proxy (for direct parser unit
  coverage) proves classification never reads them.
- Reports expose neither session IDs nor discovered session cwd paths.

## Command suite: `test/commands/history.test.ts`

- Registry finds `history`; help includes the exact grammar.
- No flags passes `30d/all/current cwd` into the analyzer.
- Every accepted flag combination produces schema version 1 in JSON mode.
- Text mode renders filters, supported table, unsupported list, coverage, warnings, and the fixed
  session-attribution disclaimer.
- Unknown subcommand, missing value, invalid value, duplicate conflicting value, and stray
  positional argument fail with exit code 1 and accepted-value guidance.
- JSON stdout is one parseable value; diagnostics never corrupt stdout.

## Skill contracts

### `test/history-analyze-skill.test.ts`

- Requires frontmatter identity `history-analyze` and calls `omp history analyze`.
- Documents defaults and all allowed filters.
- States actual-event-only, no-content-read, session-level-only, and warning-preservation rules.
- Package/setup manifest coverage proves normal distribution.

### Extend `test/skill-bench-skill.test.ts`

- Bare branch orders `omp history analyze --window 30d --project all --json` before `/grill-me`.
- Only the three mapped skills are offered as benchmarkable; unsupported observations are listed.
- Requires an explicit affirmative answer before reaching existing live runner commands.
- Refusal, ambiguity, no supported rows, analyzer failure, and unavailable grill-me stop without a
  Python live-task command.
- Existing assertions for `check`, `latest`, mappings, selftest, models, runs, workers, report path,
  and opener remain and must pass unchanged.
- Unknown explicit argument still prints modes and stops; direct arguments bypass history/grill.

## Integration and regression commands

Run in this order, fixing failures before proceeding:

```bash
npx vitest run test/history/analyze.test.ts test/commands/history.test.ts \
  test/history-analyze-skill.test.ts test/skill-bench-skill.test.ts
npx vitest run test/memory-review/transcript.test.ts test/cli.test.ts test/copilot/setup.test.ts
npm run build
npm run lint
npm test
npm run lint:skills
npm run check:catalog
npm run scan:skills
python3 -m unittest benchmarks/skill-bench/test_run.py benchmarks/skill-bench/test_report.py
python3 benchmarks/skill-bench/run.py --selftest
npm pack --dry-run --json
```

Inspect the npm-pack JSON and require `dist/src/history/analyze.js`,
`dist/src/commands/history.js`, `.github/skills/history-analyze/SKILL.md`, the modified skill-bench,
and `benchmarks/skill-bench`.

## Fresh community smoke

1. Build and link the worktree with the active npm installation.
2. From a clean temporary Git repository run plain `omp setup`; do not use plugin-cache edits or
   path flags.
3. Start a fresh Copilot process and verify `copilot skill list --json` lists `history-analyze` and
   `skill-bench`.
4. Run `omp history analyze --window 30d --project all --json`; validate schema and warnings without
   reading conversation content.
5. Invoke bare `/skill-bench`, verify the history-supported/unsupported presentation and one
   `/grill-me` confirmation question, then answer no and prove no benchmark run directory appears.
6. Direct-mode smoke may use `/skill-bench check`. Do not run live benchmark cells unless a human
   separately gives explicit confirmation for that smoke.

## PASS/FAIL evidence format

For every command record `PASS` or `FAIL`, exit code, and the decisive output line/test counts.
For fresh smoke record package root, target cwd, discovered skill names, history schema version,
and the absence/presence of a new run directory. A skipped live benchmark is `PASS (safety gate
verified; live spend not authorized)`, not an unreported gap.
