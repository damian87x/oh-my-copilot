# Skill Bench Out-of-Box Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plain `omp setup` install a bundled `/skill-bench` into the active Git project and let the skill run the packaged benchmark from any working directory.

**Architecture:** Bound project discovery at the nearest Git root, add one concise skill that resolves the active omp package root, and include the existing benchmark directory in npm artifacts. Keep `omp setup` as the supported copy mechanism and validate through a fresh Copilot process.

**Tech Stack:** TypeScript, Vitest, Markdown Agent Skills, Python 3 benchmark harness, npm linking.

## Global Constraints

- Normal local usage is `npm link`, then plain `omp setup` from the target project.
- Do not require `--root`, `--plugin-root`, temporary directories, or plugin-cache edits.
- Preserve local skill edits: setup without `--force` must retain existing skip-changed behavior.
- Live task modes run nested Copilot benchmark cells; `check` and `latest` do not start those
  cells, though their containing Copilot turn still uses the session model.
- Add no dependencies.

---

### Task 1: Bound project discovery at the Git repository

**Files:**
- Modify: `src/project.ts:51-61`
- Test: `test/project.test.ts`

**Interfaces:**
- Consumes: `findUp(start, marker)` and `resolveProjectPaths({ cwd })`.
- Produces: `resolveProjectPaths()` returning the nearest in-repository package root or Git root.

- [ ] **Step 1: Write a failing test** that creates `parent/package.json`, `parent/workspace/.git`, and a nested cwd, then expects `resolveProjectPaths({ cwd }).packageRoot` to equal `parent/workspace`.
- [ ] **Step 2: Run** `npx vitest run test/project.test.ts` and confirm the test fails by returning the parent directory.
- [ ] **Step 3: Implement** Git-boundary-aware discovery: accept a package root only when it is equal to or contained by the nearest Git root; otherwise return the Git root. Preserve nearest-package behavior outside Git repositories.
- [ ] **Step 4: Run** `npx vitest run test/project.test.ts test/copilot/setup.test.ts` and confirm both suites pass.

### Task 2: Add and package `/skill-bench`

**Files:**
- Create: `.github/skills/skill-bench/SKILL.md`
- Modify: `package.json`
- Test: `test/skill-bench-skill.test.ts`

**Interfaces:**
- Consumes: `omp version --json`, `benchmarks/skill-bench/run.py`, and the report path printed by the runner.
- Produces: `/skill-bench check|latest|code-review|tdd|ralplan`.

- [ ] **Step 1: Write a failing test** that requires the skill file, checks the three task mappings plus `check`/`latest`, checks package-root resolution through `omp version --json`, and asserts `package.json#files` includes `benchmarks/skill-bench`.
- [ ] **Step 2: Run** `npx vitest run test/skill-bench-skill.test.ts` and confirm it fails because the skill is absent.
- [ ] **Step 3: Create the minimal skill** with directory identity `skill-bench`, concise argument routing, no-spend selftest gate, package-root lookup, live defaults, report opening, and result summary contract.
- [ ] **Step 4: Add** `benchmarks/skill-bench` to `package.json#files`.
- [ ] **Step 5: Run** the focused test, `npm run lint:skills`, and `npm pack --dry-run --json`; confirm the skill and benchmark files are present.

### Task 3: Correct local-development documentation

**Files:**
- Modify: `README.md:459-487`

**Interfaces:**
- Consumes: the linked package and setup behavior from Tasks 1-2.
- Produces: one supported local test flow with no path flags.

- [ ] **Step 1: Replace** manual installed-plugin cache copying with `npm run build`, `npm link`, `cd <target>`, `omp setup`, and a fresh-session note.
- [ ] **Step 2: Document** `/skill-bench check` as the no-spend discovery smoke.
- [ ] **Step 3: Run** `rg -n "installed-plugins.*cp -R|omp setup|skill-bench check" README.md` and confirm only the supported flow remains.

### Task 4: Verify and install the linked experience

**Files:**
- Verify only: source worktree and `/Users/damianborek/workspace/MoltCore-workspace`

**Interfaces:**
- Consumes: built package, npm links, and plain setup.
- Produces: a fresh target project where `/skill-bench` is discoverable.

- [ ] **Step 1: Run** focused and full validation: `npm run build`, `npm test`, `npm run lint:skills`, `npm run check:catalog`, `npm run scan:skills`, and benchmark Python tests/selftest.
- [ ] **Step 2: Link** both Homebrew and active NVM npm installations to this worktree, then verify `omp version --json` from `MoltCore-workspace` reports package `0.25.0` and this worktree path.
- [ ] **Step 3: Run** plain `omp setup` from `MoltCore-workspace` without path flags. Verify it targets that Git root and copies `.github/skills/skill-bench/SKILL.md` without overwriting changed skills.
- [ ] **Step 4: Run** a fresh `copilot skill list --json` process from `MoltCore-workspace` and assert `skill-bench` is listed.
- [ ] **Step 5: Run** a fresh `/skill-bench check` smoke, read its output, and confirm all instruments are valid without nested benchmark cells.
- [ ] **Step 6: Commit and push** with Lore trailers recording setup semantics, verification, and any environmental gaps.
