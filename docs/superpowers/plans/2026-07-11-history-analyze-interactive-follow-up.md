# Interactive History Analyze Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/history-analyze` from a raw/report-only endpoint into a concise human summary followed by one safely confirmed benchmark next step.

**Architecture:** Keep `omp history analyze --json` and `src/history/analyze.ts` unchanged as the deterministic data boundary. Change only the bundled skill contract so JSON is internal transport, then reuse the existing `/grill-me` and `/skill-bench` skills for confirmation and execution rather than duplicating benchmark logic.

**Tech Stack:** Copilot Agent Skills markdown, Vitest contract tests, existing OMP setup/link flow, Copilot CLI session JSONL evidence.

## Global Constraints

- Count only actual `tool.execution_start` skill invocations; never inspect or infer from conversation content.
- Preserve exact numeric values, every warning, session-level-only attribution, and metric-specific coverage.
- Never print or paste raw analyzer JSON from `/history-analyze`.
- Never start `python3 run.py --task` before an unambiguous affirmative answer.
- Keep `omp history analyze`, its JSON schema, direct `/skill-bench` modes, benchmark mappings, models, arms, repetitions, and workers unchanged.
- Add no dependencies.

---

### Task 1: Lock the interactive skill contract

**Files:**
- Modify: `test/history-analyze-skill.test.ts`
- Test: `test/history-analyze-skill.test.ts`

**Interfaces:**
- Consumes: `.github/skills/history-analyze/SKILL.md` as plain text.
- Produces: regression assertions for human presentation, `/grill-me`, `/skill-bench`, and the no-spend boundary.

- [ ] **Step 1: Replace the report-only assertion with the interactive contract**

Add these assertions after the existing privacy and exact-value assertions:

```ts
expect(skill).toContain("Do not print or paste raw JSON");
expect(skill).toContain("Present a concise human-readable summary");
expect(skill).toContain("top-level `skills` array");
expect(skill).toContain('Call the `skill` tool with `skill: "grill-me"`');
expect(skill).toContain('Call the `skill` tool with `skill: "skill-bench"`');
expect(skill).toContain("direct mode for the selected skill");
expect(skill).toContain("Do not start any `python3 run.py --task` command before");
expect(skill).toContain("On refusal, ambiguity, analyzer failure, no supported skill, or unavailable handoff");
expect(skill).not.toContain("Return only the requested history report");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run test/history-analyze-skill.test.ts
```

Expected: FAIL because the current skill does not prohibit raw JSON or define the two skill-tool handoffs.

### Task 2: Implement the human summary and safe continuation

**Files:**
- Modify: `.github/skills/history-analyze/SKILL.md`
- Modify: `README.md`
- Test: `test/history-analyze-skill.test.ts`

**Interfaces:**
- Consumes: schema-version-1 fields `filters`, `coverage`, `skills`, `unsupportedSkills`, `sessionUsage`, and `warnings` from `omp history analyze --json`.
- Produces: a human report and, after Yes only, a direct-mode handoff to the existing `skill-bench` skill.

- [ ] **Step 1: Make JSON internal transport and define the summary**

Replace the report-only ending with this behavior:

```markdown
## Present the history

Do not print or paste raw JSON. Present a concise human-readable summary containing:

- the normalized window and project scope,
- coverage counts,
- ranked entries from the top-level `skills` array,
- observed entries from `unsupportedSkills`,
- every present `sessionUsage` total with its matching `metricSessions` value,
- single-skill associations and the shared-skill bucket, and
- every warning exactly as returned.

Copy numeric values exactly. Do not round, abbreviate, rescale, recalculate, or describe
session-level usage as per-skill cost.
```

- [ ] **Step 2: Add one guarded next step**

Append this exact control flow:

```markdown
## Offer the next step

If the top-level `skills` array is empty, print the valid guided and direct `/skill-bench` commands
and stop. Otherwise select the first ranked entry.

Call the `skill` tool with `skill: "grill-me"`. Do not call `ask_user` before loading it. Ask exactly
one question naming the selected skill and explaining that Yes starts live benchmark cells and uses
model quota.

On refusal, ambiguity, analyzer failure, no supported skill, or unavailable handoff, stop without
loading `skill-bench` and print the valid commands.

Only after an unambiguous affirmative answer, call the `skill` tool with `skill: "skill-bench"` and
follow its direct mode for the selected skill. Do not start any `python3 run.py --task` command before
that answer, and do not duplicate benchmark execution inside this skill.
```

- [ ] **Step 3: Clarify README usage**

Change the `/history-analyze` catalog description to say it summarizes actual usage and offers one
confirmed benchmark next step. Add examples near the setup smoke section:

```text
/history-analyze
/history-analyze 7d current
```

State that raw JSON is available through `omp history analyze --json`, while the slash skill renders
a human summary and asks before any live benchmark.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run test/history-analyze-skill.test.ts test/skill-bench-skill.test.ts
npm run lint:skills
```

Expected: 2 files pass; skill lint reports no issues.

### Task 3: Prove setup, refusal safety, and regression coverage

**Files:**
- Verify only: `.github/skills/history-analyze/SKILL.md`
- Verify only: `.github/skills/skill-bench/SKILL.md`
- Verify only: `README.md`

**Interfaces:**
- Consumes: linked `omp`, plain project setup, and Copilot CLI's session event log.
- Produces: machine-checkable proof that the user-facing flow is discoverable and spends nothing on No.

- [ ] **Step 1: Run repository quality gates**

```bash
npm run build
npx vitest run test/history/analyze.test.ts test/commands/history.test.ts test/history-analyze-skill.test.ts test/skill-bench-skill.test.ts
npm test
npm run lint
npm run lint:skills
npm run check:catalog
npm run scan:skills
```

Expected: build passes; focused and full tests pass; zero lint errors; skill/catalog validation passes;
no new high or medium safety finding.

- [ ] **Step 2: Relink and install through the supported path**

From the OMP checkout run both existing `npm link` variants. In the MoltCore target, remove only the
copied `.github/skills/history-analyze` directory, run plain `omp setup`, and byte-compare the copied
skill to the linked checkout. Start a fresh Copilot session because skills load at session start.

- [ ] **Step 3: Run a fresh interactive refusal smoke**

Snapshot `benchmarks/skill-bench/runs`, start Copilot in the target project, submit:

```text
/history-analyze
```

At the `/grill-me` question answer No. Verify the new session log contains, in order:

1. `skill(history-analyze)`
2. `omp history analyze --window 30d --project all --json`
3. `skill(grill-me)`

Verify it contains no `skill(skill-bench)`, no `python3 run.py --task`, no raw JSON final response,
and no change to the run-directory snapshot.

- [ ] **Step 4: Run mandatory Ralph review gates**

Run an architect review of the final diff and runtime evidence. On approval, run `ai-slop-cleaner`
in standard mode on the Ralph-owned files only, then rerun the focused tests, full tests, build, and
lint gates.

- [ ] **Step 5: Deliver**

Commit with Lore trailers, push `feature/skills-spec-and-sweep`, verify both global `omp` realpaths,
write and read back the Ralph completion audit, then run `omx cancel`.
