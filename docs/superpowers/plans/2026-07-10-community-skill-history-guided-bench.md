# Community Skill History and Guided Benchmark Implementation Plan

> **Executor requirement:** implement with TDD, one task at a time. Do not start a live benchmark
> cell without explicit user confirmation.

**Goal:** Add local deterministic skill-history analysis and use it to guide bare `/skill-bench`
through a `/grill-me` confirmation gate while preserving every existing explicit mode.

**Architecture:** A dependency-free analyzer in `src/history/analyze.ts` owns safe event parsing and
aggregation. A registered `src/commands/history.ts` owns CLI grammar/rendering. Bundled skills are
thin orchestration layers; the existing Python benchmark remains authoritative.

## Global constraints

- Count only actual skill tool-start events; never infer from content.
- Do not read prompt or assistant content.
- Invocation counts are exact for readable events; usage is session-level only.
- Defaults are `30d/all`; filters are exactly `7d|30d|90d|all` and `current|all`.
- No new dependency and no benchmark-harness redesign.
- Observe focused tests fail before implementation and pass after the smallest change.

### Task 1: Lock the analyzer contract with fixtures

**Files:** Create `test/history/analyze.test.ts`; create fixture helpers within that test or
`test/history/fixtures.ts`.

- [ ] Write failing tests for actual-event-only classification, malformed-line tolerance, privacy
  sentinels, session discovery, all windows/scopes, stable sorting, warnings, supported mappings,
  unsupported rows, and session-level telemetry honesty from the test specification.
- [ ] Run `npx vitest run test/history/analyze.test.ts`; confirm failure is missing module/API, not
  invalid fixtures.
- [ ] Preserve the exact schema field names and omission rules from the design; do not weaken tests
  to accommodate implementation convenience.

### Task 2: Implement the deterministic analyzer

**Files:** Create `src/history/analyze.ts`; reuse `isValidSessionId` from
`src/memory-review/transcript.ts` without changing transcript behavior.

- [ ] Implement validated session discovery and line-by-line defensive event parsing with injected
  session root and time.
- [ ] Classify only exact skill tool-start events and aggregate exact counts/session cardinality.
- [ ] Implement inclusive window and exact resolved-current-project filtering.
- [ ] Implement supported/unsupported mapping, stable ordering, coalesced warnings, coverage, and
  session-level shutdown totals with invalid-value omission.
- [ ] Run the focused test until green, then run
  `npx vitest run test/memory-review/transcript.test.ts` for reuse regression evidence.

### Task 3: Add registered `omp history analyze`

**Files:** Create `src/commands/history.ts`; modify `src/commands/registry.ts`; minimally modify
`src/cli.ts` only if registered-command dispatch/help cannot express the locked contract; create
`test/commands/history.test.ts`; extend `test/cli.test.ts` if needed.

- [ ] Write failing command tests for defaults, flags, schema output, text rendering, help, and all
  error cases in the test specification.
- [ ] Implement strict argument parsing and a `CommandModule` adapter; register `history`.
- [ ] Ensure `--json` produces one JSON value and text output always includes the attribution limit.
- [ ] Run `npx vitest run test/commands/history.test.ts test/cli.test.ts` until green.

### Task 4: Bundle `/history-analyze`

**Files:** Create `.github/skills/history-analyze/SKILL.md`; create
`test/history-analyze-skill.test.ts`; update README skill documentation only where the repository's
existing bundled-skill table requires it.

- [ ] Write a failing contract test for identity, command, filters, privacy, event-only counts,
  warnings, and session-level attribution language.
- [ ] Author the minimal skill that delegates deterministic work to the CLI and never inspects
  conversation content itself.
- [ ] Run the focused test and `npm run lint:skills`; confirm normal setup/package discovery.

### Task 5: Gate bare `/skill-bench` through history and `/grill-me`

**Files:** Modify `.github/skills/skill-bench/SKILL.md`; extend `test/skill-bench-skill.test.ts`.

- [ ] Add failing tests for bare-mode ordering, supported-only ranking, unsupported listing, single
  `/grill-me` question, affirmative-only continuation, and every safe-stop branch.
- [ ] Snapshot/retain existing direct/check/latest assertions before editing.
- [ ] Change only the bare-argument branch: call default history JSON, present results, invoke
  `/grill-me`, and after affirmative confirmation reuse the selected direct mapping.
- [ ] Keep unknown explicit arguments as mode-list-and-stop; keep explicit supported arguments as
  direct consent with no history/grill detour.
- [ ] Run `npx vitest run test/skill-bench-skill.test.ts` and `npm run lint:skills` until green.

### Task 6: Document the community contract

**Files:** Modify `README.md` and relevant skill documentation tables; do not copy the MoltCore
project-local implementation.

- [ ] Document `omp history analyze`, defaults, all filters, actual-event-only counting, coverage
  warnings, and session-level-only usage.
- [ ] Document bare guided benchmark and explicit confirmation; document unchanged direct modes.
- [ ] Search for contradictory claims of prompt inference, per-skill cost, or automatic live runs:
  `rg -n "history analyze|per-skill|skill-bench|session-level|prompt infer" README.md docs .github`.

### Task 7: Full verification and fresh-session safety smoke

**Files:** Verification only, except minimal fixes required by failures within this plan's scope.

- [ ] Run all commands from the test specification and capture PASS/FAIL plus decisive output.
- [ ] Inspect `npm pack --dry-run --json` for the analyzer, command, both skills, and benchmark.
- [ ] Use the supported flow (`npm link`, plain `omp setup`, fresh Copilot process) in a clean Git
  target; verify both skills are discoverable.
- [ ] Verify history JSON schema version 1 and privacy/coverage messaging against local history.
- [ ] Invoke bare `/skill-bench`, refuse at `/grill-me`, and prove no new live run directory exists.
- [ ] Treat live direct-mode benchmark smoke as not authorized unless the user explicitly confirms;
  `/skill-bench check` remains the non-live execution smoke.
- [ ] Run `/code-review` on the final diff and resolve all blockers before handoff.

## Handoff and stop conditions

Handoff includes changed-file list, schema confirmation, verification matrix, fresh-session evidence,
and any telemetry coverage warnings. Stop only when all deterministic checks pass, both skills are
fresh-session discoverable, direct-mode regressions are clean, and the no-confirmation safety gate
has evidence. Do not manufacture live-spend evidence when authorization is absent.

