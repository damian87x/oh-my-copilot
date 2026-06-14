# Verification Plan — PR #31 (skill audit fixes + Copilot-native hooks)

> Purpose: prove every change in PR #31 actually works against a real Copilot CLI
> session. Split into what is ALREADY verified (no re-run needed) and the DEFERRED
> live checks that need Copilot model quota (Free tier resets Jul 1; or use Pro).

## Legend
- ✅ done = already executed and green this cycle (do not redo)
- ⏳ deferred = needs Copilot model quota; run when available

## Verification log — 2026-06-13 (live, no model quota needed)
**B1 (hooks fire) EXECUTED and a real bug was found + fixed.**
- Copilot CLI 1.0.61 DOES load+run plugin hooks (logged `Invalid hooks config … hooks must be an object` on the old Claude-format file; accepted the new v1 format with no error).
- First live run: every hook fired but failed — `HookExitCodeError: code 1` — because the command used `${OMP_PLUGIN_ROOT:-$OMC_PLUGIN_ROOT}`, which Copilot does NOT set. Captured the hook runtime env: Copilot exposes **`COPILOT_PLUGIN_ROOT`** (and `PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`).
- Fix (commit e7658d8): manifest now uses `${COPILOT_PLUGIN_ROOT:-…}`.
- Re-run after fix: `.omp/state/hooks.log` recorded `SessionStart` (correct `directory`), `UserPromptSubmit`, and `errorOccurred` (caught the quota error); **zero new HookExitCodeError**. → B1 PASS.
- Still ⏳: `agentStop` firing on a *completed* turn + Copilot honoring `{decision:"block"}` re-prompt — the turn quota-errored (→ errorOccurred) instead of completing, so the loop re-prompt is unexercised until quota.

---

## A. Already verified (evidence on record)

| Check | How | Result |
|---|---|---|
| Build from clean | `rm -rf dist && npm run build` | ✅ |
| Unit/integration suite | `npx vitest run` | ✅ 508/508 |
| Type safety | `npx tsc -p tsconfig.json --noEmit` | ✅ clean |
| Skill lint | `node dist/src/cli.js lint:skills --root .` | ✅ 0 issues |
| Catalog | `node dist/src/cli.js catalog validate` | ✅ pass |
| Every hook script emits valid JSON | pipe Copilot payload to each `scripts/*.mjs` | ✅ 7/7 |
| `preToolUse` safe (no spurious deny) | pipe payload | ✅ allow |
| `agent-stop` fails OPEN on bad input | `echo '' \| node scripts/agent-stop.mjs` | ✅ allow |
| `agent-stop` loop math | stdin pipe: 1/3→2/3→allow+clear on sentinel; unit tests | ✅ |
| `comms send` submits (C-m→Enter) | live `omp comms send … --json` | ✅ ok=True submitted=True |
| doctor validates manifest | `omp doctor --json` | ✅ "Copilot v1, 7 events (agentStop present)" |
| Fixed skills reference omp CLI | grep | ✅ ralph/ultrawork/ultraqa/jira |

These do NOT need re-running unless code changes.

---

## B. Deferred live verification (needs Copilot model quota)

### Prerequisites
1. Quota available (Jul 1 reset, or Copilot Pro). Confirm: a trivial `omp comms ask --text "say OK" --wait` returns a model reply, not `quota_exceeded`.
2. Plugin synced to this branch: `rsync -a --delete .github/ ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/.github/` and copy `hooks/`, `plugin.json`, `scripts/` (or reinstall the plugin from this branch).
3. Restart Copilot so it loads the new hooks + skills.

### B1 — Hooks actually fire (the claim the old memory said was impossible)
Install a throwaway diagnostic that writes a file, then start a session.
- **sessionStart**: file written on boot (past trust prompt). PASS = file exists.
- **agentStop**: file written when the agent finishes a turn. PASS = file exists.
- **preToolUse/postToolUse**: file written around a tool call.
- Acceptance: ≥ sessionStart + agentStop fire. (If none fire, the `${OMP_PLUGIN_ROOT}` env resolution in `hooks/hooks.json` is the suspect — see design doc risk.)

### B2 — Native memory injection (sessionStart)
- `omp goal set "ship v1"`, start a fresh session, ask the model "what is the repo goal?".
- Acceptance: model reports the goal from `additionalContext` (not only from copilot-instructions.md). Confirm by temporarily blanking the instructions block and re-testing.

### B3 — agentStop loop driver (headline feature)
- `omp ralph start "add a --version flag to the omp CLI" --max-iterations 3`.
- Drive one short task turn; let the agent stop WITHOUT emitting `RALPH_COMPLETE`.
- Acceptance:
  - agentStop returns `{decision:"block"}` and Copilot takes another turn with the `[RALPH ITERATION n/3]` prompt.
  - `.omp/state/ralph.json` iteration increments each turn.
  - On emitting `RALPH_COMPLETE` (or hitting 3) → `{decision:"allow"}`, loop stops, state cleared.
- Repeat for `ultraqa` (cycleCount) and `ultrawork`.

### B4 — 23-skill behavioral re-run (audit Gate 2)
Re-run the existing harness against both models Copilot exposes:
```bash
node .review/driver.mjs --session <copilot-tmux> --model gpt5mini --skills all
node .review/driver.mjs --session <copilot-tmux> --model haiku45  --skills all
```
Score each transcript 0–3: (a) skill loaded (`● skill(x)`), (b) followed phase/contract, (c) produced contracted output, (d) avoided its own "do not use" anti-pattern.

Targeted acceptance for the previously-broken skills:
| skill | must observe live |
|---|---|
| ralph | runs `omp ralph start` before the work loop |
| ultrawork | runs `omp ultrawork start` |
| ultraqa | runs `omp ultraqa start` + `omp ultraqa cycle` per cycle |
| jira-ticket | runs `omp jira render` (dry-run) — does NOT improvise raw REST/create |
| research-codebase | uses native glob/grep/read (NO `task`/`view`/`explore` tool calls) |
| caveman | output is actually compressed (the static gate showed plain prose — confirm fixed or file a bug) |
| grill-me | asks exactly ONE question |

### B5 — `/team` end-to-end
- `omp team 2:copilot "<small task>" --name vtest`; confirm workers receive prompts (already verified delivery live), DO the task, and the leader aggregates results. Then `omp team shutdown vtest`.

---

## C. Sign-off checklist
- [ ] B1 sessionStart + agentStop fire
- [ ] B2 goal visible via hook injection
- [ ] B3 ralph/ultraqa/ultrawork loops re-prompt and stop correctly
- [ ] B4 all 5 previously-broken skills exhibit corrected behavior; 23-skill scores recorded to `.review/`
- [ ] B5 team completes a task end-to-end
- [ ] Any new defect filed; report appended to `.review/REPORT.md`

## D. Notes
- Cloud agents only load `.github/hooks/` (not plugin hooks) — B1–B3 target the local CLI.
- Keep all transcripts under `.review/transcripts/` for reproducibility.
EOF
