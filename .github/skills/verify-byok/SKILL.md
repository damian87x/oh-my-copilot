---
name: verify-byok
description: Verify an omp change end-to-end — static gate (build/tsc/tests/lint/catalog) plus a live BYOK run that drives Copilot/teams on a real model and captures evidence. Use before merging any PR that touches hooks, comms, team, launch, or skills.
argument-hint: "<branch-or-PR to verify>"
---

# verify-byok — evidence-based verification for omp changes

**Invocation:** `/verify-byok <branch-or-PR>`

Prove a change actually works, not just that it compiles. Two gates: a **static** gate (cheap, always) and a **live BYOK** gate (drives real Copilot CLI sessions on a Bring-Your-Own-Key model so no GitHub quota is needed). Report **real command output**, never claims. Be honest about what you did NOT test.

## When to use
Before merging any PR — especially ones touching `hooks/`, `scripts/*.mjs`, `src/comms`, `src/team`, `src/copilot/launch`, `src/copilot/trust`, or `.github/skills`. Anything whose behavior only appears at runtime (tmux submit keys, hook firing, trust dialog, model tool-calls) needs the live gate.

## Prerequisites (one-time, persistent)
- `~/.omp/.env` holds BYOK: `COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1`, `COPILOT_PROVIDER_TYPE=openai`, `COPILOT_PROVIDER_API_KEY=…`, `COPILOT_MODEL=…`, `COPILOT_PROVIDER_MODEL_ID=…`. omp auto-loads it; `~/.zshrc` sourcing it makes direct `copilot` BYOK too.
- Free model `openai/gpt-oss-120b:free` exercises plumbing but botches structured edits/`apply_patch` and narrates instead of acting — use a capable model (`anthropic/claude-sonnet-4.5` + `COPILOT_PROVIDER_MODEL_ID=claude-sonnet-4`) when verifying that real tasks complete.
- Folder trust: a session only skips the "Do you trust this folder?" dialog if the cwd is in `~/.copilot/config.json#trustedFolders` (`--yolo` does NOT skip it). `omp` auto-adds it on launch; `/private/tmp` is pre-trusted.

## Static gate (run from the branch worktree)
```bash
npm run build                              # tsc
npx tsc -p tsconfig.json --noEmit          # type-clean
npx vitest run                             # ALL must pass — note the count
node dist/src/cli.js lint:skills --root .  # 0 issues
node dist/src/cli.js catalog validate      # PASS
```
A merged-overlap PR? Confirm the test count rose (new tests survived the rebase) and old behavior's tests still pass.

## Live BYOK gate
Build the branch CLI first (`npm run build`); installed `omp` may be older. Drive Copilot inside tmux (each pane is a pty). **Submit with the `Enter` key name, never `C-m`** — Copilot ≥1.0.61 ignores `C-m`.

1. **Launch + reach a model:** `tmux new-session -d -s vbyok -c <dir>` → send `omp` (or `omp --madmax` for bypass) → wait for `/ commands`. Confirm the model line shows your BYOK model and `Session: 0 AIC used` (0 AI Credits = not on GitHub quota). Send a prompt, send `Enter`, confirm a real reply.
2. **Exercise the changed surface** — pick the user-visible behavior the change claims:
   - hooks → tail `<cwd>/.omp/state/hooks.log` for the events firing;
   - team → run a 2-worker team, confirm files/artifacts on disk and the script's `🎉 All N agents completed!` (read the raw stdout, not the leader's summary);
   - cost/minify → pipe a postToolUse payload to `scripts/post-tool-use.mjs` and check `modifiedResult` + raw preserved + ledger `savedTokens` + `omp cost`.
3. **Capture evidence**: `tmux capture-pane -p -t <session>` plus the on-disk artifact. Keep transcripts.

## Reporting (mandatory)
- PASS/FAIL table with the actual captured output (model line, reply, artifact contents, ledger numbers).
- State the model used and that no GitHub quota was consumed.
- **Honest limitations**: heuristics (e.g. pane-scrape completion detection), model-quality effects (free model botching edits), anything gated/conditional, and anything you did NOT exercise.
- Never report "works" without exercising the user-visible surface — verify before asserting.

## Anti-patterns
- Trusting a subagent's "Complete." — re-run the gate yourself.
- `C-m` to submit to Copilot (use `Enter`).
- Concluding from a green build alone — runtime bugs (env propagation, trust dialog, submit keys) pass the build and fail live.
