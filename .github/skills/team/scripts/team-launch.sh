#!/usr/bin/env bash
set -euo pipefail

# team-launch.sh — split the CURRENT tmux window into panes, each running
# an interactive Copilot CLI agent session.
#
# Usage:
#   team-launch.sh --session <name> --lanes <lanes.json>
#
# Each pane launches an interactive `omp --madmax` (or `copilot`) session,
# then sends the lane prompt via tmux send-keys so the agent stays alive
# for follow-up interaction.

SESSION=""
LANES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --lanes)   LANES_FILE="$2"; shift 2 ;;
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
  echo "tmux not found" >&2
  exit 1
fi

if [[ -z "${TMUX:-}" ]]; then
  echo "Not inside a tmux session. Run this from within tmux." >&2
  exit 1
fi

if command -v omp &>/dev/null; then
  AGENT_CMD="omp --madmax"
elif command -v copilot &>/dev/null; then
  AGENT_CMD="copilot"
else
  echo "Neither omp nor copilot CLI found" >&2
  exit 1
fi

LANE_COUNT=$(jq length "$LANES_FILE")
if [[ "$LANE_COUNT" -lt 1 ]]; then
  echo "No lanes defined in $LANES_FILE" >&2
  exit 1
fi

CWD=$(pwd)
WAIT_SECS="${TEAM_AGENT_WAIT:-5}"
LEADER_PANE=$(tmux display-message -p '#{pane_id}')

echo "🚀 Splitting current window into $LANE_COUNT panes ($SESSION)"
echo ""

# Collect pane IDs as we create them
PANE_IDS=()

for i in $(seq 0 $((LANE_COUNT - 1))); do
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  LANE_PROMPT=$(jq -r ".[$i].prompt" "$LANES_FILE")
  LANE_ID=$(jq -r ".[$i].id" "$LANES_FILE")

  # Split: alternate horizontal/vertical for a grid
  if (( i == 0 )); then
    PANE_ID=$(tmux split-window -h -c "$CWD" -P -F '#{pane_id}')
  elif (( i % 2 == 1 )); then
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-1))]}" -c "$CWD" -P -F '#{pane_id}')
  else
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-2))]}" -c "$CWD" -P -F '#{pane_id}')
  fi

  PANE_IDS+=("$PANE_ID")

  # Set pane title
  tmux select-pane -t "$PANE_ID" -T "$LANE_ID: $LANE_NAME"

  # Launch interactive agent session (NOT with -p)
  tmux send-keys -t "$PANE_ID" "echo '═══ $LANE_NAME ═══' && $AGENT_CMD" C-m

  echo "  ✅ Pane $PANE_ID → $LANE_NAME (launching agent...)"
done

# Rebalance layout
tmux select-layout tiled

# Wait for agents to start up before sending prompts
echo ""
echo "⏳ Waiting ${WAIT_SECS}s for agents to initialise..."
sleep "$WAIT_SECS"

# Now send prompts to each interactive session
for i in $(seq 0 $((LANE_COUNT - 1))); do
  LANE_PROMPT=$(jq -r ".[$i].prompt" "$LANES_FILE")
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  PANE_ID="${PANE_IDS[$i]}"

  # Write prompt to temp file and use tmux load-buffer + paste for reliable delivery
  PROMPT_FILE="/tmp/team-prompt-${SESSION}-${i}.txt"
  printf '%s' "$LANE_PROMPT" > "$PROMPT_FILE"

  # Send via tmux send-keys -l (literal) then Enter
  tmux send-keys -t "$PANE_ID" -l "$(cat "$PROMPT_FILE")"
  tmux send-keys -t "$PANE_ID" C-m

  echo "  📨 Sent prompt to $PANE_ID ($LANE_NAME)"
done

MONITOR_PID=""
MONITOR_LOG="/tmp/team-monitor-${SESSION}.log"
if command -v omp &>/dev/null; then
  MONITOR_ARGS=(team monitor-panes --leader-pane "$LEADER_PANE" --session-label "$SESSION")
  for pane_id in "${PANE_IDS[@]}"; do
    MONITOR_ARGS+=(--worker-pane "$pane_id")
  done
  if omp "${MONITOR_ARGS[@]}" >"$MONITOR_LOG" 2>&1 & then
    MONITOR_PID=$!
  fi
fi

# Switch focus back to the original (leader) pane
tmux select-pane -t '{left}'

echo ""
echo "✅ $LANE_COUNT interactive agent sessions running in split panes"
echo ""
echo "Pane IDs: ${PANE_IDS[*]}"
if [[ -n "$MONITOR_PID" ]]; then
  echo "Monitor PID: $MONITOR_PID"
  echo "Monitor log: $MONITOR_LOG"
elif ! command -v omp &>/dev/null; then
  echo "Auto-notifications unavailable: omp is not installed, so pane completion is not monitored."
fi
echo ""
echo "Commands:"
echo "  tmux select-layout tiled              # rebalance layout"
echo "  tmux capture-pane -t <pane-id> -p -S -50  # read pane output"
echo "  Ctrl-b + arrow keys                   # navigate between panes"
echo ""
echo "💡 Agents are interactive — you can send follow-up prompts to any pane"
