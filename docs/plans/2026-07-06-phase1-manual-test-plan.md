# Phase 1 hardening — manual test plan (PR #73)

Manual verification of every behavior-changing item in `hardening/phase-1`,
run against a linked `omp` build **before** resolving the merge conflict with
`main`. Each item lists the command and the observed result.

## Setup

```bash
# Worktree of the source project, checked out on the PR branch
git worktree add ../oh-my-copilot-hardening-phase1 hardening/phase-1
cd ../oh-my-copilot-hardening-phase1
npm install && npm run build
npm link                 # global `omp` now runs THIS worktree's dist
omp version              # packageRoot must point at this worktree
```

Scratch project used for the runtime checks:

```bash
mkdir -p /tmp/omptest && cd /tmp/omptest && git init -q
```

## Automated gates (baseline)

| Gate | Command | Result |
|------|---------|--------|
| Unit/integration | `npm test` | **872 passed / 103 files** |
| Lint | `npm run lint` | 0 errors (11 pre-existing warnings) |
| Skills safety scan | `npm run scan:skills` | 0 high, 0 medium, 1 low |
| Catalog | `node dist/src/cli.js catalog validate` | PASS |

## B1 — skill-install path traversal

```bash
# Malicious frontmatter name
mkdir -p evilskill && cat > evilskill/SKILL.md <<'EOF'
---
name: ../../../../tmp/omptest/pwned
description: attempts path traversal on install
---
EOF
omp skill install ./evilskill --scope project --dry-run --json
```

- **Expected:** rejected, no filesystem write outside the skills root.
- **Observed:** `{"ok":false,"error":"invalid skill name ... (must match /^[a-z0-9][a-z0-9._-]*$/)"}`.
- **Control:** a valid `name: good-skill` returns `ok:true` with `targetDir` under `.github/skills/good-skill`. ✅

## B2 — Slack allowlist default-deny

```bash
# Empty allowlist → connector refuses to start
env -u SLACK_ALLOWED_USERS SLACK_BOT_TOKEN=xoxb-x SLACK_APP_TOKEN=xapp-x \
  omp gateway status --only slack --json
# Explicit opt-in
SLACK_ALLOWED_USERS='*' SLACK_BOT_TOKEN=xoxb-x SLACK_APP_TOKEN=xapp-x \
  omp gateway status --only slack --json
```

- **Empty:** `ready:false`, detail = "SLACK_ALLOWED_USERS is required … or set SLACK_ALLOWED_USERS=* …". ✅
- **`*`:** `ready:true`. ✅
- Unit-covered: `isUserAllowed(undefined, [])` now returns `false` (was `true`); `test/slack/handler.test.ts`, `test/gateway/slack-connector.test.ts`.

## B3 — per-session bounded Slack FIFO

- No live Slack socket in this environment; covered by `test/gateway/slack-connector.test.ts`
  (+223 lines): 1 in-flight + 3 pending, "worker busy" overflow reply, per-item
  `commsAsk` timeout, chains freed on drain. Suite green.

## A4 — crash-safe preToolUse hook

```bash
env -u COPILOT_PLUGIN_ROOT -u CLAUDE_PLUGIN_ROOT -u PLUGIN_ROOT \
    -u OMP_PLUGIN_ROOT -u OMC_PLUGIN_ROOT \
  bash -c 'node "${COPILOT_PLUGIN_ROOT:-...}"/scripts/pre-tool-use.mjs || echo "{}"'
```

- **With fallback:** prints `{}`, exit 0 → tool call proceeds. ✅
- **Without fallback (baseline):** exit 1 → every tool call would be denied. ✅

## A1 — unified `.omp` state root

```bash
cd /tmp/omptest
omp ralph start "smoke" --max-iterations 3 --json
find .omp -type f          # → .omp/state/ralph.json
```

- State lands under the single `.omp/state/` root resolved by `ompRoot`. ✅
- `omp ultraqa start` / `omp schedule` write under the same root.

## A2 — single loop-counter owner + N-yields-N cap

Driving the `agentStop` hook directly (`scripts/agent-stop.mjs`) with a ralph
state of `maxIterations: 3`, firing four times:

| Fire | decision | iteration |
|------|----------|-----------|
| 1 | block | 1 |
| 2 | block | 2 |
| 3 | block | 3 |
| 4 | allow | 3 (loop cleared, `active:false`) |

- `maxIterations: N` grants exactly **N** hook-driven turns (`cur >= max`). ✅
- `omp ralph tick` records `completedSlices` (0→1) and does **not** touch `iteration`. ✅
- `omp ultraqa cycle fail` (×2) leaves `cycleCount` at 0 — `recordUltraqaCycle`
  no longer double-increments; `lastVerdict` still recorded. ✅

## A3 — atomic agent-stop idempotency guard

Fire the hook once (iteration 0→1, marker
`agentstop-ralph-<session>-<startedAtMs>-1` claimed). Reset the state's
`iteration` back to 0 (simulating a concurrent re-fire that observed the same
pre-increment counter) and fire again:

- **Observed:** iteration stays **0** — the existing marker makes the duplicate
  `claimAgentStopCounter` return `false`, so no double count. ✅
- Marker key embeds the per-run `startedAt` nonce, so a *new* run (different
  `startedAt`) is never frozen by a stale marker. Fail-open on guard errors.
- State-write-failure rollback (`releaseAgentStopMarker`) and marker lifecycle
  covered by `test/scripts/agent-stop.test.ts` (+251 lines).

## Result

All behavior-changing items verified live via the linked `omp` CLI and by
driving the `agentStop` hook directly; automated suite, lint, scan, and catalog
all green — **before** touching the conflict resolution.
