#!/usr/bin/env bash
set -euo pipefail

# team-launch.sh — start one interactive Copilot CLI agent per lane, either as
# herdr-core (`hc`) terminals (default) or as panes split into the CURRENT tmux
# window.
#
# Usage:
#   team-launch.sh --session <name> --lanes <lanes.json>
#
# Backend (same rule as src/team/mux.ts):
#   OMP_MUX=herdr|tmux, else "mux" in ${COPILOT_HOME:-~/.copilot}/omp.json,
#   else auto: inside hc ⇒ herdr, inside tmux ⇒ tmux, otherwise herdr.
#   herdr selected but hc missing ⇒ tmux (with a notice).
#
# Flow:
#   1. Start one agent per lane (hc terminal or tmux pane)
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

if [[ ! "$SESSION" =~ ^[A-Za-z0-9._-]+$ || "$SESSION" == "." || "$SESSION" == ".." || ${#SESSION} -gt 128 ]]; then
  echo "Invalid session: use 1-128 letters, digits, dots, underscores, or hyphens" >&2
  exit 1
fi

if [[ ! -f "$LANES_FILE" ]]; then
  echo "Lanes file not found: $LANES_FILE" >&2
  exit 1
fi

# ── backend selection ────────────────────────────────────────────────

hc_bin() {
  if [[ -n "${OMP_HC_BIN:-}" ]]; then
    [[ -x "$OMP_HC_BIN" ]] && printf '%s\n' "$OMP_HC_BIN"
    return 0
  fi
  local candidate
  candidate=$(command -v hc 2>/dev/null || true)
  if [[ -n "$candidate" ]] && "$candidate" --version 2>/dev/null | grep -q '^hc '; then
    printf '%s\n' "$candidate"; return 0
  fi
  command -v herdr-core 2>/dev/null || true
}

# Prints "<backend> <source>" where source is env|config|auto.
mux_backend() {
  local m
  m=$(printf '%s' "${OMP_MUX:-}" | tr '[:upper:]' '[:lower:]')
  if [[ "$m" == "herdr" || "$m" == "tmux" ]]; then printf '%s env\n' "$m"; return; fi
  local cfg="${COPILOT_HOME:-$HOME/.copilot}/omp.json"
  if [[ -f "$cfg" ]]; then m=$(jq -r '.mux // empty' "$cfg" 2>/dev/null || true); fi
  if [[ "$m" == "herdr" || "$m" == "tmux" ]]; then printf '%s config\n' "$m"; return; fi
  # HERDR_ENV=1 is the Herdr TUI pane (herdr CLI). HC_TERMINAL_ID is herdr-core.
  if [[ -n "${HC_TERMINAL_ID:-}" || "${HERDR_ENV:-}" == "1" ]]; then m="herdr"
  elif [[ -n "${TMUX:-}" ]]; then m="tmux"
  else m="herdr"; fi
  printf '%s auto\n' "$m"
}

read -r MUX MUX_SOURCE <<< "$(mux_backend)"
HC=""
HERDR_CLI=""
if [[ "$MUX" == "herdr" ]]; then
  HC=$(hc_bin)
  if [[ -z "$HC" && "${HERDR_ENV:-}" == "1" ]]; then
    HERDR_CLI=$(command -v herdr 2>/dev/null || true)
    if [[ -n "$HERDR_CLI" ]] && ! "$HERDR_CLI" --version 2>/dev/null | grep -q '^herdr '; then
      HERDR_CLI=""
    fi
  fi
  if [[ -z "$HC" && -z "$HERDR_CLI" && "$MUX_SOURCE" == "auto" ]]; then
    MUX="tmux"
  elif [[ -z "$HC" && -z "$HERDR_CLI" ]]; then
    echo "ℹ️  hc not found; using tmux. Install: https://herdr.dev or set \"mux\":\"tmux\" in ${COPILOT_HOME:-$HOME/.copilot}/omp.json" >&2
    MUX="tmux"
  fi
fi

if [[ "$MUX" == "tmux" ]]; then
  if ! command -v tmux &>/dev/null; then
    echo "tmux not found" >&2; exit 1
  fi
  if [[ -z "${TMUX:-}" ]]; then
    echo "Not inside a tmux session. Run this from within tmux." >&2; exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PACKAGE_VERSION="$(jq -r '.version // empty' "$PACKAGE_ROOT/plugin.json" 2>/dev/null || true)"
CONTROL_CLI=""

if [[ -n "${OMP_TEAM_CONTROL_CLI:-}" ]]; then
  if [[ "$OMP_TEAM_CONTROL_CLI" = /* && -x "$OMP_TEAM_CONTROL_CLI" ]]; then
    CONTROL_CLI="$OMP_TEAM_CONTROL_CLI"
  else
    echo "⚠️  OMP_TEAM_CONTROL_CLI must be an absolute executable path; visual monitoring is disabled" >&2
  fi
elif [[ -x "$PACKAGE_ROOT/dist/src/cli.js" ]]; then
  CONTROL_CLI="$PACKAGE_ROOT/dist/src/cli.js"
elif command -v omp &>/dev/null; then
  INSTALLED_VERSION="$(omp version --json 2>/dev/null | jq -r '.package // empty' 2>/dev/null || true)"
  if [[ -n "$PACKAGE_VERSION" && "$INSTALLED_VERSION" == "$PACKAGE_VERSION" ]]; then
    CONTROL_CLI="$(command -v omp)"
  else
    echo "⚠️  Installed omp version does not match this package; visual monitoring is disabled" >&2
  fi
else
  echo "⚠️  No matching omp control CLI found; visual monitoring is disabled" >&2
fi

# OMP_TEAM_WORKER tags worker sessions so the agentStop hook skips loop
# injection — otherwise a worker spawned inside a project with an active
# ralph/ultrawork/ultraqa loop gets hijacked by "[RALPH ITERATION N]" prompts.
if command -v omp &>/dev/null; then
  AGENT_CMD="OMP_TEAM_WORKER=1 omp --madmax"
  AGENT_ARGV=(omp --madmax)
elif command -v copilot &>/dev/null; then
  # --yolo = all permissions (tools+paths+urls) so worker panes never block on a
  # trust/permission dialog. Matches the bypass `omp --madmax` grants.
  AGENT_CMD="OMP_TEAM_WORKER=1 copilot --yolo"
  AGENT_ARGV=(copilot --yolo)
else
  echo "Neither omp nor copilot CLI found" >&2; exit 1
fi

# herdr workers are started by the control CLI (`team hc-spawn`): it writes the
# private env file (PATH, COPILOT_*, GitHub auth, OMP_TEAM_WORKER) so no secret
# ever reaches hc's argv. Without it there is no safe way to launch on herdr.
if [[ "$MUX" == "herdr" && -z "$HERDR_CLI" && -z "$CONTROL_CLI" ]]; then
  echo "herdr backend needs a matching omp control CLI (see warning above); rerun with OMP_MUX=tmux" >&2
  exit 1
fi

CWD=$(pwd -P)
if [[ "$MUX" == "herdr" ]]; then
  if command -v sha256sum &>/dev/null; then
    HC_GROUP="omp-$(printf '%s\0%s' "$CWD" "$SESSION" | sha256sum | cut -c1-12)"
  else
    HC_GROUP="omp-$(printf '%s\0%s' "$CWD" "$SESSION" | shasum -a 256 | cut -c1-12)"
  fi
fi

if ! jq -e '
  type == "array" and
  length > 0 and
  all(.[];
    (.id | type == "string") and
    (.id | test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) and
    (.name | type == "string") and
    (.prompt | type == "string")
  ) and
  (([.[].id] | length) == ([.[].id] | unique | length))
' "$LANES_FILE" >/dev/null; then
  echo "Invalid lanes file: lane ids must be unique path-safe names and name/prompt must be strings" >&2
  exit 1
fi
LANE_COUNT=$(jq length "$LANES_FILE")

# Each worker writes its final result here so the lead can collect deterministically
# (`omp team collect --dir`), rather than scraping live panes.
DELIVERY_DIR="/tmp/team-$SESSION"
if [[ -e "$DELIVERY_DIR" || -L "$DELIVERY_DIR" ]]; then
  echo "Delivery directory already exists; choose a fresh session name: $DELIVERY_DIR" >&2
  exit 1
fi
if ! (umask 077 && mkdir "$DELIVERY_DIR"); then
  echo "Unable to create a private delivery directory: $DELIVERY_DIR" >&2
  exit 1
fi
POLL="${TEAM_POLL_INTERVAL:-2}"
MAX_READY="${TEAM_MAX_READY_WAIT:-60}"
MAX_DONE="${TEAM_MAX_COMPLETION_WAIT:-300}"
if command -v uuidgen &>/dev/null; then
  LAUNCH_ID="$(uuidgen)"
else
  LAUNCH_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
fi

# ── helpers ──────────────────────────────────────────────────────────

# Capture visible pane content (last N lines). hc returns the whole screen plus
# history, so trim trailing blank rows and keep the last N lines.
pane_text() {
  if [[ -n "$HERDR_CLI" ]]; then
    "$HERDR_CLI" pane read "$1" --source recent-unwrapped --lines "${2:-20}" 2>/dev/null || true
    return
  fi
  if [[ "$MUX" == "herdr" ]]; then
    "$HC" read "$1" --lines "${2:-20}" 2>/dev/null \
      | awk -v n="${2:-20}" '{l[NR]=$0} END{e=NR; while(e>0 && l[e] ~ /^[[:space:]]*$/) e--; s=e-n+1; if(s<1)s=1; for(i=s;i<=e;i++) print l[i]}' \
      || true
  else
    tmux capture-pane -t "$1" -p -S "-${2:-20}" 2>/dev/null || true
  fi
}

# Press Enter in a pane.
pane_enter() {
  if [[ -n "$HERDR_CLI" ]]; then
    "$HERDR_CLI" pane send-keys "$1" enter >/dev/null 2>&1 || true
  elif [[ "$MUX" == "herdr" ]]; then
    "$HC" keys "$1" enter >/dev/null 2>&1 || true
  else
    tmux send-keys -t "$1" Enter
  fi
}

# Is the pane/terminal still running? On herdr only finished/not_found is dead;
# an unreachable core is not proof of death.
pane_alive() {
  if [[ -n "$HERDR_CLI" ]]; then
    "$HERDR_CLI" pane get "$1" >/dev/null 2>&1
    return
  fi
  if [[ "$MUX" == "herdr" ]]; then
    local out rc=0
    out=$("$HC" get "$1" --json 2>/dev/null) || rc=$?
    if (( rc == 0 )); then
      [[ "$(printf '%s' "$out" | jq -r '.state // empty' 2>/dev/null)" != "finished" ]]
      return
    fi
    (( rc != 3 ))
    return
  fi
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -q "^${1}$"
}

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
      pane_enter "$pane"
      accepted=1
      echo "    ↳ Auto-accepted folder trust for $pane"
    fi

    sleep "$POLL"
    elapsed=$((elapsed + POLL))
  done
  return 1
}

# ── step 1: create panes ─────────────────────────────────────────────

if [[ "$MUX" == "herdr" ]]; then
  echo "🚀 Starting $LANE_COUNT herdr terminals ($SESSION → ${HC_GROUP}-w*)"
else
  echo "🚀 Splitting current window into $LANE_COUNT panes ($SESSION)"
fi
echo ""

PANE_IDS=()
HC_NAMES=()
for i in $(seq 0 $((LANE_COUNT - 1))); do
  LANE_NAME=$(jq -r ".[$i].name" "$LANES_FILE")
  LANE_ID=$(jq -r ".[$i].id" "$LANES_FILE")

  if [[ -n "$HERDR_CLI" ]]; then
    HC_NAME="${HC_GROUP}-w$((i + 1))"
    DIR=right
    (( i % 2 == 1 )) && DIR=down
    if ! SPAWN_OUT=$("$HERDR_CLI" agent start "$HC_NAME" --cwd "$CWD" --split "$DIR" --no-focus -- env OMP_TEAM_WORKER=1 OMP_MUX=herdr "${AGENT_ARGV[@]}"); then
      echo "  ❌ $LANE_NAME: herdr agent start failed" >&2
      for started in ${PANE_IDS[@]+"${PANE_IDS[@]}"}; do "$HERDR_CLI" pane close "$started" >/dev/null 2>&1 || true; done
      exit 1
    fi
    PANE_ID=$(printf '%s' "$SPAWN_OUT" | jq -r '.result.agent.pane_id // .address // empty')
    if [[ -z "$PANE_ID" ]]; then
      echo "  ❌ $LANE_NAME: unexpected herdr agent start output: $SPAWN_OUT" >&2; exit 1
    fi
    PANE_IDS+=("$PANE_ID")
    HC_NAMES+=("$HC_NAME")
    echo "  ✅ $HC_NAME ($PANE_ID) → $LANE_NAME"
    continue
  fi

  if [[ "$MUX" == "herdr" ]]; then
    HC_NAME="${HC_GROUP}-w$((i + 1))"
    SPAWN=("$CONTROL_CLI" team hc-spawn --json --name "$HC_NAME" --cwd "$CWD"
      --label "omp.launch=$LAUNCH_ID" --label "omp.lane=$LANE_ID" --label "omp.team=$SESSION"
      --set OMP_TEAM_WORKER=1 --set OMP_MUX=herdr)
    # Inside Herdr keep the parent link so lanes show in the user's tab.
    if [[ -n "${HC_TERMINAL_ID:-}" ]]; then SPAWN+=(--keep-parent); fi
    if ! SPAWN_OUT=$("${SPAWN[@]}" -- "${AGENT_ARGV[@]}"); then
      echo "  ❌ $LANE_NAME: hc-spawn failed" >&2
      for started in ${PANE_IDS[@]+"${PANE_IDS[@]}"}; do "$HC" kill "$started" >/dev/null 2>&1 || true; "$HC" rm "$started" >/dev/null 2>&1 || true; done
      exit 1
    fi
    PANE_ID=$(printf '%s' "$SPAWN_OUT" | jq -r '.address // empty')
    if [[ ! "$PANE_ID" =~ ^t[0-9]+[a-z]?$ ]]; then
      echo "  ❌ $LANE_NAME: unexpected hc-spawn output: $SPAWN_OUT" >&2; exit 1
    fi
    PANE_IDS+=("$PANE_ID")
    HC_NAMES+=("$HC_NAME")
    if [[ -n "${HC_TERMINAL_ID:-}" ]] && command -v herdr-app &>/dev/null; then
      herdr-app do terminal.keep "{\"terminal\":\"$PANE_ID\",\"place\":\"right\"}" >/dev/null 2>&1 \
        || echo "  ⚠️  herdr-app could not show $PANE_ID as a pane; it is still listed under your tab's agents" >&2
    fi
    echo "  ✅ $HC_NAME ($PANE_ID) → $LANE_NAME"
    continue
  fi

  if (( i == 0 )); then
    PANE_ID=$(tmux split-window -h -c "$CWD" -P -F '#{pane_id}')
  elif (( i % 2 == 1 )); then
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-1))]}" -c "$CWD" -P -F '#{pane_id}')
  else
    PANE_ID=$(tmux split-window -v -t "${PANE_IDS[$((i-2))]}" -c "$CWD" -P -F '#{pane_id}')
  fi
  PANE_IDS+=("$PANE_ID")

  tmux set-option -p -t "$PANE_ID" @omp_launch_uuid "$LAUNCH_ID"
  tmux set-option -p -t "$PANE_ID" @omp_lane_id "$LANE_ID"
  tmux select-pane -t "$PANE_ID" -T "$LANE_ID: $LANE_NAME"
  tmux send-keys -t "$PANE_ID" "$AGENT_CMD" C-m

  echo "  ✅ Pane $PANE_ID → $LANE_NAME"
done

if [[ "$MUX" == "tmux" ]]; then tmux select-layout tiled; fi

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
  LANE_ID=$(jq -r ".[$i].id" "$LANES_FILE")
  PANE_ID="${PANE_IDS[$i]}"

  # Append a deterministic delivery instruction: the worker writes its final
  # result to a file so the lead's `omp team collect` knows it's done (vs
  # guessing from the pane). Kept on one line so send-keys submits cleanly.
  LANE_PROMPT="$LANE_PROMPT  IMPORTANT: when fully finished, write your complete final result to the file $DELIVERY_DIR/$LANE_ID.result.md (e.g. with a heredoc), then stop."

  # -l = literal (no key interpretation), then submit. Use the `Enter` key NAME,
  # not C-m: Copilot CLI >=1.0.61 ignores a literal carriage return, so C-m left
  # the prompt sitting unsent in the input buffer and the agent never started.
  if [[ -n "$HERDR_CLI" ]]; then
    # 0.6.x agent send is literal text; Enter is a separate key. Do not resend.
    if ! "$HERDR_CLI" agent send "${HC_NAMES[$i]}" "$LANE_PROMPT" >/dev/null 2>&1 \
      || ! "$HERDR_CLI" pane send-keys "$PANE_ID" enter >/dev/null 2>&1; then
      echo "  ⚠️  herdr send to $PANE_ID ($LANE_NAME) failed; check it with: $HERDR_CLI agent read ${HC_NAMES[$i]}" >&2
      continue
    fi
  elif [[ "$MUX" == "herdr" ]]; then
    # One call: hc pastes and presses Enter. Never resend on failure — the core
    # may already have queued it.
    if ! "$HC" send "$PANE_ID" "$LANE_PROMPT" >/dev/null 2>&1; then
      echo "  ⚠️  hc send to $PANE_ID ($LANE_NAME) failed; check it with: $HC read $PANE_ID" >&2
      continue
    fi
  else
    tmux send-keys -t "$PANE_ID" -l "$LANE_PROMPT"
    sleep 0.3
    tmux send-keys -t "$PANE_ID" Enter
  fi

  echo "  📨 Sent to $PANE_ID ($LANE_NAME)"
done

if [[ "$MUX" == "tmux" ]]; then tmux select-pane -t '{left}'; fi

# Write the manifest before registration so the control CLI can validate the
# exact launch generation and pane map before the monitor discovers it.
MANIFEST="[]"
for i in $(seq 0 $((LANE_COUNT - 1))); do
  MANIFEST=$(echo "$MANIFEST" | jq \
    --arg id "$(jq -r ".[$i].id" "$LANES_FILE")" \
    --arg name "$(jq -r ".[$i].name" "$LANES_FILE")" \
    --arg pane "${PANE_IDS[$i]}" \
    --arg mux "$MUX" \
    'if $mux == "herdr" then . + [{id:$id,name:$name,paneId:$pane,mux:"herdr"}] else . + [{id:$id,name:$name,paneId:$pane}] end')
done
echo "$MANIFEST" > "$DELIVERY_DIR/manifest.json"

if [[ "$MUX" == "herdr" ]]; then
  echo "ℹ️  Loop-monitor nudges are not available on herdr yet; use omp team collect to track lanes."
elif [[ -n "$CONTROL_CLI" ]]; then
  TMUX_IDENTITY=$(tmux display-message -p -t "${PANE_IDS[0]}" \
    -F '#{socket_path}|#{pid}|#{start_time}|#{session_id}|#{session_created}|#{window_id}')
  IFS='|' read -r SOCKET_PATH SERVER_PID SERVER_START_TIME SESSION_ID SESSION_CREATED WINDOW_ID _ <<< "$TMUX_IDENTITY"

  if ! "$CONTROL_CLI" team register-visual \
    --root "$CWD" \
    --name "$SESSION" \
    --launch-id "$LAUNCH_ID" \
    --dir "$DELIVERY_DIR" \
    --manifest "$DELIVERY_DIR/manifest.json" \
    --socket "$SOCKET_PATH" \
    --server-pid "$SERVER_PID" \
    --server-start-time "$SERVER_START_TIME" \
    --session-id "$SESSION_ID" \
    --session-created "$SESSION_CREATED" \
    --window-id "$WINDOW_ID" \
    --json >/dev/null; then
    echo "⚠️  Visual team registration failed; agents remain available in tmux" >&2
  fi
fi

# Prompts are sent — in --no-monitor mode return now so the caller (a Copilot
# lead) doesn't block on the long monitor loop and doesn't get killed mid-run
# by its shell-tool cleanup. The agents keep working in the panes for the user
# to watch; this is the default for the in-session visual flow.
if [[ -n "$NO_MONITOR" ]]; then
  echo ""
  echo "✅ $LANE_COUNT agents launched and prompted ($SESSION)."
  echo "📋 Lane → pane:"
  for i in $(seq 0 $((LANE_COUNT - 1))); do
    echo "   $(jq -r ".[$i].name" "$LANES_FILE") → ${PANE_IDS[$i]}"
  done
  if [[ -n "$HERDR_CLI" ]]; then
    echo "👀 Watch a lane: herdr agent focus <name>  (names: ${HC_NAMES[*]})"
  elif [[ "$MUX" == "herdr" ]]; then
    echo "👀 Watch a lane: $HC attach <name>  (Ctrl+\\ detaches; names: ${HC_NAMES[*]})"
  fi
  echo ""
  echo "➡️  Collect — poll this until allDone, then read each lane's result and synthesize:"
  if [[ -n "$CONTROL_CLI" ]]; then
    printf '   %q team collect --dir %q --json\n' "$CONTROL_CLI" "$DELIVERY_DIR"
  else
    echo "   omp team collect --dir $DELIVERY_DIR --json"
  fi
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
    if ! pane_alive "$PANE_ID"; then
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
  if pane_alive "$PANE_ID"; then
    pane_text "$PANE_ID" 40 | grep -E '●|✅|❌|⚠|error|Error|FAIL|PASS|done|Done' | tail -10 || echo "  (no notable output captured)"
  else
    echo "  (pane no longer exists)"
  fi
done

echo ""
echo "Pane IDs: ${PANE_IDS[*]}"
if [[ -n "$HERDR_CLI" ]]; then
  echo "Watch: herdr agent focus <name> — names: ${HC_NAMES[*]}"
elif [[ "$MUX" == "herdr" ]]; then
  echo "Watch: $HC attach <name> (Ctrl+\\ detaches) — names: ${HC_NAMES[*]}"
else
  echo "Navigate: Ctrl-b + arrow keys"
fi
echo "💡 Agents are interactive — send follow-up prompts to any pane"
