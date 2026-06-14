# Design: Copilot-native hooks + `agentStop` loop driver

> Status: PLAN (no code yet). Scoped 2026-06-13. Separate from `fix/skill-cli-wiring`.
> Suggested branch: `feat/copilot-native-hooks`.

## Problem

omp ships lifecycle hooks (`hooks/hooks.json` + `scripts/*.mjs`) but **none fire in
Copilot CLI**. Earlier this was attributed to "Copilot doesn't run hooks." That is
no longer true — Copilot CLI supports hooks; omp's are simply in the **wrong
schema**, so Copilot loads the file and matches zero events.

### Evidence
- `node dist/src/cli.js` pane-state probe: omp's `ACTIVE_HINTS` miss Copilot 1.0.61's
  real working indicator (`◉ Working esc cancel`) → busy-gate never fires (separate bug).
- `hooks/hooks.json` uses Claude Code schema: PascalCase events
  (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`,
  `Error`), `matcher`/`command`/`timeout` keys.
- Copilot expects camelCase events + `version:1` + `bash`/`timeoutSec` keys, and has
  an event omp doesn't define: **`agentStop`**.
- Docs: https://docs.github.com/en/copilot/reference/hooks-configuration ,
  https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks

## Copilot hook facts (verified from docs)

Load order (all merged, all matching entries run): policy → repo `.github/hooks/*.json`
→ user `~/.copilot/hooks/*.json` → inline `.github/copilot/settings.json` (and
`.claude/settings.json` cross-tool) → user `~/.copilot/settings.json` → **plugin
`hooks.json` or `hooks/hooks.json` in the plugin install dir**. Cloud agents load
ONLY `.github/hooks/*.json`.

Events + interventional outputs:
| event | input (key fields) | output that matters |
|---|---|---|
| `sessionStart` | `sessionId, cwd, source(startup\|resume\|new), initialPrompt?` | `additionalContext` (injected as user message) |
| `userPromptSubmitted` | prompt text | output ignored |
| `preToolUse` | tool name, args (`matcher` supported) | `permissionDecision` allow/deny/ask, `modifiedArgs`, `permissionDecisionReason` (fail-closed) |
| `postToolUse` | tool, args, result | `modifiedResult`, `additionalContext` |
| `postToolUseFailure` | tool, args, error | `additionalContext` |
| `errorOccurred` | error details | output ignored |
| `agentStop` | `sessionId, cwd, transcriptPath, stopReason:"end_turn"` | `{decision:"block"\|"allow", reason}` — `block` forces another turn, `reason` = next-turn prompt |

Hook I/O contract: input JSON on stdin, output JSON on stdout. Hook types:
`command` (bash/powershell), `http`, `prompt`.

## Design

### Slice 1 — Port the hook manifest to Copilot format
Rewrite `hooks/hooks.json` to:
```json
{
  "version": 1,
  "hooks": {
    "sessionStart":        [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/session-start.mjs", "timeoutSec": 5 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/prompt-submit.mjs", "timeoutSec": 5 }],
    "preToolUse":          [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/pre-tool-use.mjs", "timeoutSec": 5 }],
    "postToolUse":         [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/post-tool-use.mjs", "timeoutSec": 5 }],
    "errorOccurred":       [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/error.mjs", "timeoutSec": 5 }],
    "sessionEnd":          [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/session-end.mjs", "timeoutSec": 5 }],
    "agentStop":           [{ "type": "command", "bash": "node \"$OMP_PLUGIN_ROOT\"/scripts/agent-stop.mjs", "timeoutSec": 10 }]
  }
}
```
Resolve `$OMP_PLUGIN_ROOT` (the plugin install dir). Keep `hooks/hooks.json` path
(it is a recognized plugin source). Verify event names load via a throwaway diagnostic.

### Slice 2 — Update script I/O contracts to Copilot schema
Each `scripts/*.mjs` must read Copilot's input JSON from stdin and emit Copilot's
output JSON to stdout (today they assume Claude shapes / print plain text):
- `session-start.mjs`: emit `{ "additionalContext": "<memory block>" }` — native
  replacement for the copilot-instructions.md managed block (keep that as fallback).
- `pre-tool-use.mjs`: emit `{ "permissionDecision": "allow|deny|ask", ... }` only if
  omp wants policy; otherwise no-op (REMEMBER: fail-closed — a crash denies the tool).
- `post-tool-use.mjs` / `error.mjs` / `session-end.mjs` / `prompt-submit.mjs`: adapt
  fields; note `userPromptSubmitted`/`errorOccurred`/`sessionEnd` outputs are ignored.

### Slice 3 — `agentStop` loop driver (the OMC-style loop)
New `scripts/agent-stop.mjs`:
1. Read input `{ transcriptPath, cwd, ... }`.
2. Read loop state `.omp/state/{ralph|ultrawork|ultraqa}.json` (already exists). If no
   loop is active → `{decision:"allow"}` (normal stop).
3. If active: tick the state machine (reuse `tickRalph`/equivalent) → check completion:
   - completion sentinel present in transcript (e.g. `RALPH_DONE`) OR PRD/criteria met → `omp ralph cancel`, `{decision:"allow"}`.
   - max iterations reached → `{decision:"allow"}` + note "stopped at cap".
   - else → `{decision:"block", reason:"[RALPH ITERATION n/max] Not done. Continue. Output RALPH_DONE only when all acceptance criteria pass."}`.
4. This makes `/ralph`, `/ultrawork`, `/ultraqa` self-drive without pane-scraping.

This supersedes the current in-prompt loop wiring from `fix/skill-cli-wiring`
(those CLI calls remain valid as the state source the hook reads).

### Slice 4 — fix stale `ACTIVE_HINTS` (carry from audit)
Add Copilot 1.0.61 working markers (`Working esc cancel`, spinner glyphs `◉○◐◑`,
elapsed timer) so the `commsSend` busy-gate and any fallback pane-state work for
headless `copilot -p` (which skips hooks). Small; could also land on the fix branch.

### Slice 5 — `omp setup` writes/refreshes hooks
Ensure `omp setup` installs the Copilot-format hooks (plugin dir is automatic;
optionally also offer `~/.copilot/hooks/omp.json` for non-plugin installs). `omp doctor`
should check that the manifest parses as Copilot v1 and that `agentStop` is present.

## Verification plan
- Static: a diagnostic hook (absolute path, writes a file) fires on `sessionStart` and
  `agentStop` in a real interactive session (the test the old memory used to prove they
  DON'T fire — now expected to PASS).
- Unit: `agent-stop.mjs` decision logic (active+incomplete → block; complete → allow;
  cap → allow) with a fake transcript + state file.
- **Live (post-quota, after Jul 1 or Pro):** run `/ralph` on a small task and confirm it
  iterates via `agentStop` re-prompts until the sentinel, then stops. This is the only
  part that needs model quota.

## Risks / open questions
- `$OMP_PLUGIN_ROOT` resolution inside the bash hook (env availability at hook runtime).
- `preToolUse` is fail-closed — a buggy omp pre-tool hook would block ALL tools; keep it
  trivially safe or omit until needed.
- Double memory injection if both `sessionStart` additionalContext AND the
  copilot-instructions.md block are active — pick one as primary, keep the other as fallback.
- Loop sentinel reliability: model must emit the exact completion token; needs a clear
  contract in the ralph SKILL.md.
- Cloud agents only load `.github/hooks/` — plugin hooks won't apply there.
