#!/usr/bin/env bash
set -euo pipefail

# team-launch.sh — split the CURRENT tmux window into panes, each running
# an interactive Copilot CLI agent session.
#
# Usage:
#   team-launch.sh --session <name> --lanes <lanes.json>
#
# Flow:
#   1. Split panes and launch agent CLI in each
#   2. Wait for each agent to be ready (auto-accept folder trust prompts)
#   3. Send lane prompts via send-keys
#   4. Monitor until all agents finish, then print summary

SESSION=""
LANES_FILE=""
NO_MONITOR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)    SESSION="$2"; shift 2 ;;
    --lanes)      LANES_FILE="$2"; shift 2 ;;
    --no-monitor) NO_MONITOR=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SESSION" || -z "$LANES_FILE" ]]; then
  echo "Usage: team-launch.sh --session <name> --lanes <lanes.json>" >&2
  exit 1
fi

if [[ ! -f "$LANES_FILE" ]]; then
  echo "Lanes file not found: $LANES_FILE" >&2
  exit 1
fi

if ! command -v tmux &>/dev/null; then
  echo "tmux not found" >&2; exit 1
fi

if [[ -z "${TMUX:-}" ]]; then
  echo "Not inside a tmux session. Run this from within tmux." >&2; exit 1
fi

# OMP_TEAM_WORKER tags worker sessions so the agentStop hook skips loop
# injection — otherwise a worker spawned inside a project with an active
# ralph/ultrawork/ultraqa loop gets hijacked by "[RALPH ITERATION N]" prompts.
if command -v omp &>/dev/null; then
  AGENT_CMD="OMP_TEAM_WORKER=1 omp --madmax"
elif command -v copilot &>/dev/null; then
  # --yolo = all permissions (tools+paths+urls) so worker panes never block on a
  # trust/permission dialog. Matches the bypass `omp --madmax` grants.
  AGENT_CMD="OMP_TEAM_WORKER=1 copilot --yolo"
else
  echo "Neither omp nor copilot CLI found" >&2; exit 1
fi

LANE_COUNT=$(jq length "$LANES_FILE")
if [[ "$LANE_COUNT" -lt 1 ]]; then
  echo "No lanes defined in $LANES_FILE" >&2; exit 1
fi

CWD=$(pwd)
POLL="${TEAM_POLL_INTERVAL:-2}"
MAX_READY="${TEAM_MAX_READY_WAIT:-60}"
MAX_DONE="${TEAM_MAX_COMPLETION_WAIT:-300}"

# ── helpers ──────────────────────────────────────────────────────────

# Capture visible pane content (last N lines)
pane_text() { tmux capture-pane -t "$1" -p -S "-${2:-20}" 2>/dev/null || true; }

# Wait until the agent CLI is fully ready ('/ commands' status bar visible).
# Auto-accepts the folder-trust dialog if it appears.
wait_for_ready() {
  local pane="$1" elapsed=0 accepted=0
  while (( elapsed < MAX_READY )); do
    local txt
    txt=$(pane_text "$pane" 25)

    # Ready: the '/ commands' status bar means the CLI input prompt is active
    if echo "$txt" | grep -q '/ commands'; then
      return 0
    fi

    # Auto-accept folder trust dialog. Use the `Enter` key NAME, not C-m:
    # Copilot CLI >=1.0.61 ignores a literal carriage return (C-m) for TUI
    # selection/submit, so C-m left the trust dialog open and the agent hung.
    if (( accepted == 0 )) && echo "$txt" | grep -q 'Do you trust'; then
      tmux send-keys -t "$pane" Enter
      accepted=1
      echo "    ↳ Auto-accepted folder trust for $pane"
    fi

    sleep "$POLL"
    elapsed=$((elapsed + POLL))
  done
  return 1
}

# ── step 1: create panes ─────────────────────────────────────────────

echo "🚀 Splitting current window into $LANE_COUNT panes ($SESSION)"
echo ""

PANE_IDS=()
for i in $(seq 0 $((LANE_COUNT - 1))); do
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  LANE_ID=$(jq -r ".[$i].id" "$LANES_FILE")

  if (( i == 0 )); then
    PANE_ID=$(tmux split-window -h -c "$CWD" -P -F '#{pane_id}')
  elif (( i % 2 == 1 )); then
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-1))]}" -c "$CWD" -P -F '#{pane_id}')
  else
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-2))]}" -c "$CWD" -P -F '#{pane_id}')
  fi
  PANE_IDS+=("$PANE_ID")

  tmux select-pane -t "$PANE_ID" -T "$LANE_ID: $LANE_NAME"
  tmux send-keys -t "$PANE_ID" "$AGENT_CMD" C-m

  echo "  ✅ Pane $PANE_ID → $LANE_NAME"
done

tmux select-layout tiled

# ── step 2: wait for readiness ───────────────────────────────────────

echo ""
echo "⏳ Waiting for agents to initialise (up to ${MAX_READY}s)..."

for i in $(seq 0 $((LANE_COUNT - 1))); do
  PANE_ID="${PANE_IDS[$i]}"
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  if wait_for_ready "$PANE_ID"; then
    echo "  ✅ $PANE_ID ($LANE_NAME) ready"
  else
    echo "  ⚠️  $PANE_ID ($LANE_NAME) not ready after ${MAX_READY}s — sending anyway"
  fi
done

# ── step 3: send prompts (literal text + Enter separately) ───────────

echo ""
echo "📨 Sending prompts..."
for i in $(seq 0 $((LANE_COUNT - 1))); do
  LANE_PROMPT=$(jq -r ".[$i].prompt" "$LANES_FILE")
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  PANE_ID="${PANE_IDS[$i]}"

  # -l = literal (no key interpretation), then submit. Use the `Enter` key NAME,
  # not C-m: Copilot CLI >=1.0.61 ignores a literal carriage return, so C-m left
  # the prompt sitting unsent in the input buffer and the agent never started.
  tmux send-keys -t "$PANE_ID" -l "$LANE_PROMPT"
  sleep 0.3
  tmux send-keys -t "$PANE_ID" Enter

  echo "  📨 Sent to $PANE_ID ($LANE_NAME)"
done

tmux select-pane -t '{left}'

# Prompts are sent — in --no-monitor mode return now so the caller (a Copilot
# lead) doesn't block on the long monitor loop and doesn't get killed mid-run
# by its shell-tool cleanup. The agents keep working in the panes for the user
# to watch; this is the default for the in-session visual flow.
if [[ -n "$NO_MONITOR" ]]; then
  echo ""
  echo "✅ $LANE_COUNT agents launched and prompted — watch the panes ($SESSION)."
  exit 0
fi

# ── step 4: monitor completion ───────────────────────────────────────

echo ""
echo "⏳ Monitoring agents for completion (up to ${MAX_DONE}s)..."

# Brief pause so agents start processing before we poll
sleep 5

# State per lane: 0=waiting-for-busy, 1=busy, 2=done
LANE_STATE=()
for i in $(seq 0 $((LANE_COUNT - 1))); do LANE_STATE[$i]=0; done

COMPLETED=0
ELAPSED=0
while (( COMPLETED < LANE_COUNT && ELAPSED < MAX_DONE )); do
  sleep "$POLL"
  ELAPSED=$((ELAPSED + POLL))

  for i in $(seq 0 $((LANE_COUNT - 1))); do
    [[ "${LANE_STATE[$i]}" == "2" ]] && continue

    PANE_ID="${PANE_IDS[$i]}"
    LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")

    # Pane died?
    if ! tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${PANE_ID}$"; then
      echo "  ❌ $PANE_ID ($LANE_NAME) — pane died"
      LANE_STATE[$i]=2; COMPLETED=$((COMPLETED + 1)); continue
    fi

    local_capture=$(pane_text "$PANE_ID" 15)

    # State 0→1: agent started working (response marker ● appears)
    if [[ "${LANE_STATE[$i]}" == "0" ]]; then
      if echo "$local_capture" | grep -q '●'; then
        LANE_STATE[$i]=1
      fi
      continue
    fi

    # State 1→2: agent finished (back to idle — '/ commands' in last 5 lines)
    if echo "$local_capture" | tail -5 | grep -q '/ commands'; then
      echo "  ✅ $PANE_ID ($LANE_NAME) — agent finished"
      LANE_STATE[$i]=2; COMPLETED=$((COMPLETED + 1))
    fi
  done
done

echo ""
if (( COMPLETED == LANE_COUNT )); then
  echo "🎉 All $LANE_COUNT agents completed!"
else
  echo "⏰ Timeout — $((LANE_COUNT - COMPLETED)) agent(s) still running"
fi

# ── summary ──────────────────────────────────────────────────────────

echo ""
echo "═══ Results Summary ═══"
for i in $(seq 0 $((LANE_COUNT - 1))); do
  PANE_ID="${PANE_IDS[$i]}"
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  LANE_ID=$(jq -r ".[$i].id" "$LANES_FILE")
  echo ""
  echo "── $LANE_ID: $LANE_NAME ($PANE_ID) ──"
  if tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${PANE_ID}$"; then
    pane_text "$PANE_ID" 40 | grep -E '●|✅|❌|⚠|error|Error|FAIL|PASS|done|Done' | tail -10 || echo "  (no notable output captured)"
  else
    echo "  (pane no longer exists)"
  fi
done

echo ""
echo "Pane IDs: ${PANE_IDS[*]}"
echo "Navigate: Ctrl-b + arrow keys"
echo "💡 Agents are interactive — send follow-up prompts to any pane"
