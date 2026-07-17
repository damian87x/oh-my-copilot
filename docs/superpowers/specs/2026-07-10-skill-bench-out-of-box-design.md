# Skill Bench Out-of-Box Design

## Superseded status

This design is superseded by the dynamic `omp skill-bench` command and its bundled
`/skill-bench` skill entry point. The original packaged harness and hard-coded task
mapping approach has been removed and must not be restored as a compatibility path.

Current local-development documentation may use the linked-checkout workflow:

```bash
npm run build
npm link
cd /path/to/project
omp setup
omp
```

Packaged community documentation must use the out-of-box workflow from any project:

```bash
omp setup
omp
```

A fresh Copilot session should discover the bundled `/skill-bench` skill after `omp
setup`. The skill delegates execution to `omp skill-bench` from the active `omp`
installation; it must not require a repository checkout, Python, internal runner
working directory, symlink, plugin-cache edit, or implementation script.

## Current contract

- `omp setup` is the supported way to copy bundled skills into the active project.
- Users start with `/skill-bench` or a documented direct skill mode in a fresh Copilot
  session after setup.
- The skill resolves and calls the active `omp skill-bench` command rather than
  describing internal runner files.
- Skill discovery, model candidates, supported modes, and generated artifact IDs are
  dynamic command behavior, not fixed documentation constants.
- History and default model/profile/budget choices are recommendations only. Explicit
  safe skill paths and model IDs remain allowed. Provider model probes are opt-in and
  target only explicit IDs; `unknown` is not treated as unavailable.
- Bare guided discovery persists duplicate identities separately and hands selection
  back to the conversational skill instead of failing or selecting one silently.
- `resume` owns reviewed manifest import, gate approvals, and freeze. `run` accepts
  only a frozen spec ID or safe spec path, requires explicit pilot or validated mode,
  and starts provider cells only when `--approve-spend` records consent bound to the
  frozen semantic spec.
- `export` first writes a hash-bound privacy preview and requires a second identical
  invocation with `--approve` before writing the requested portable bundle.
- `apply --dry-run` reads current managed routing state and Copilot instruction markers.
  Conflicts block mutation; Copilot interactive instructions remain advisory.
- Missing prerequisites, unsupported modes, and runner failures are reported by the
  command/skill surface that produced them.

## Distribution contract

The npm package should include the CLI command and bundled skills needed for the
supported workflow. It should not include or document a separate benchmark working
copy as a user-facing runtime dependency.

`omp setup` remains the local project installation path for bundled skills. Direct
edits to a global plugin cache are not part of the supported workflow.

## Documentation contract

Documentation for this surface should:

1. Show the build/link/setup/fresh-session flow for local verification.
2. Show the packaged out-of-box setup/fresh-session flow without requiring this
   repository checkout or Python.
3. Point users to `/skill-bench` and `omp skill-bench` as the supported entry points.
4. Describe modes and reports as dynamic command output.
5. Avoid hard-coded historical task identifiers, model lists, fixture names, or
   package-internal runner commands.
6. Avoid instructing users to run from an internal runner working directory.

## Verification

- Unit tests cover project-root discovery and bundled skill installation behavior.
- CLI tests cover `omp skill-bench` argument handling and report/run metadata.
- Skill tests cover that `/skill-bench` calls the dynamic command path and does not
  expose removed runner internals.
- Local smoke verification uses `npm run build`, `npm link`, `omp setup`, a fresh
  Copilot session, and the supported skill/CLI entry points.
- Packaged smoke verification uses `omp setup` in a clean project and proves the
  workflow does not depend on this repository checkout, Python, or package-internal
  benchmark paths.

## Non-goals

- No global settings hacks or direct edits to Copilot's installed-plugin cache.
- No compatibility shim for the removed packaged harness.
- No documentation of package-internal runner commands or fixed historical task IDs.
- No automatic full multi-run benchmark on a missing argument.
