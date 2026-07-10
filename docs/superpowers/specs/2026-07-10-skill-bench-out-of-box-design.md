# Skill Bench Out-of-Box Design

## Goal

Make a locally linked or published `omp` expose `/skill-bench` through the normal flow:

```bash
npm run build
npm link
cd /path/to/project
omp setup
omp
```

The fresh Copilot session must then accept `/skill-bench code-review` without `--root`,
`--plugin-root`, temporary directories, or visible Python commands.

## Current failures

1. Two global Node installations can point `omp` at different worktrees. Local verification must
   prove the executable selected by the target project's `PATH` reports the current package root.
2. Project discovery follows `package.json` beyond the nearest Git boundary. A repository without
   a root `package.json`, such as `MoltCore-workspace`, is incorrectly installed into the user's
   home directory when a parent `package.json` exists there.
3. No bundled `skill-bench` skill exists.
4. `benchmarks/skill-bench` is excluded from the npm package, so a published skill could not find
   its execution engine.
5. The README's local-skill instructions describe manual plugin-cache copying even though
   `omp setup` already copies bundled skills into the active project.

## Architecture

### Project-root boundary

`resolveProjectPaths()` will treat the nearest `.git` directory as a discovery boundary. A
`package.json` found inside that repository remains the preferred package root; a package found
above the Git root is ignored. If the repository has no package file, the Git root itself is the
project root. Non-Git directories retain the existing nearest-package-or-cwd behavior.

### Bundled skill

Create `.github/skills/skill-bench/SKILL.md`. The skill resolves the active omp package with
`omp version --json`, locates `benchmarks/skill-bench`, and owns the Python invocation internally.
Users only see these commands:

- `/skill-bench check` — scorer selftest, no model calls.
- `/skill-bench latest` — rescore and open the latest saved report, no model calls.
- `/skill-bench code-review` — `code-review-sqli` across baseline, skill, and prompt arms.
- `/skill-bench tdd` — `tdd-slugify` across the same arms.
- `/skill-bench ralplan` — `ralplan-pwreset` across the same arms.

Live task modes use `gpt-5-mini,claude-haiku-4.5`, one repetition, and two workers by default.
The explicit task-mode invocation is consent to run real Copilot cells. The skill must run the
no-spend selftest first, stop on failure, open the generated HTML, and summarize winner, USD,
AI credits, and token columns. Missing Python, benchmark files, Copilot CLI, or report output is
reported directly rather than hidden.

### Distribution

Add `benchmarks/skill-bench` to `package.json#files`. This makes the execution engine available
both from a local `npm link` and from the published npm package. `omp setup` continues to copy
bundled skills into the current project's `.github/skills`; the installed Copilot plugin remains
the global release distribution path.

### Documentation

Replace the manual plugin-cache copy instructions with the supported local flow: build, `npm
link`, run plain `omp setup` from the target project, and start a fresh session because Copilot
loads skills at session start.

## Verification

1. Unit-test Git-root-bounded project discovery with a parent home-like `package.json`.
2. Assert the bundled skill exists, carries the friendly mappings, and the npm package includes
   the benchmark engine.
3. Run build, focused tests, full tests, skill lint, catalog validation, and package dry-run.
4. Link both active npm installations to the current worktree.
5. From `MoltCore-workspace`, prove `omp version --json` reports the current worktree.
6. Run plain `omp setup`, verify `.github/skills/skill-bench/SKILL.md`, then confirm discovery
   with a fresh `copilot skill list --json` process and `/skill-bench check` smoke.

## Non-goals

- No global settings hacks or direct edits to Copilot's installed-plugin cache.
- No new benchmark implementation; the existing Python harness stays authoritative.
- No automatic full multi-run benchmark on a missing argument.
