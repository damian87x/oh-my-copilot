---
name: team
description: Split an approved plan into parallel tmux panes in the current window so the user can watch agents work. Prefer this visual flow by default; use `omp team` only when the user explicitly wants background execution or runtime messaging/status APIs.
argument-hint: "<number of workers> <task description>"
---

# Team — tmux-based parallel agent execution

`/team` launches independent Copilot CLI agents in parallel tmux panes.

**Default behavior:** use the **split-window** flow so the user sees agents working in the current tmux window.

Use **runtime mode** (`omp team`) only when the user explicitly asks for background execution, detached monitoring, or runtime APIs like status, nudging, or worker messaging.

Two modes available:

| Mode | Command | Panes visible in | Best for |
|------|---------|-------------------|----------|
| **Split** | `team-launch.sh` | Current window | **Default**. Visual demo, watching agents work |
| **Runtime** | `omp team N:copilot "task"` | Separate tmux session | Explicit background jobs, task tracking, nudging, messaging |

## When to use

- Work has **independent lanes** (no shared files, no ordering constraints)
- You want parallel execution in split terminals

## Default mode — Split window (`team-launch.sh`)

Use this unless the user asks for background execution.

### When to choose it

- The user wants to **see** the agents working
- You want panes in the **current tmux window**
- You are demoing or smoke-testing the skill

### Step 1 — Write lanes JSON

Write a temporary file at `/tmp/team-lanes-<timestamp>.json`:

```json
[
  { "id": "lane-a", "name": "Short name", "prompt": "Complete self-contained task prompt..." },
  { "id": "lane-b", "name": "Another lane", "prompt": "Another task prompt..." }
]
```

### Step 2 — Launch

Resolve the launcher (installed plugin if present, else a dev checkout) and run
it with `--no-monitor`. That mode splits the panes, launches the agents, sends
each lane's prompt, then returns (~20–30s) — it does NOT block on the long
completion-monitor loop. Run it in the **foreground** (no `&`/`nohup`): a
backgrounded launcher gets killed by your shell-tool cleanup before it sends the
prompts, leaving the agents idle.

```bash
if [ -f ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/.github/skills/team/scripts/team-launch.sh ]; then
  bash ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/.github/skills/team/scripts/team-launch.sh \
    --session "team-<name>" --lanes <lanes-file> --no-monitor
else
  bash .github/skills/team/scripts/team-launch.sh \
    --session "team-<name>" --lanes <lanes-file> --no-monitor
fi
```

The script (with `--no-monitor`):
1. Splits the **current window** into panes
2. Launches `omp --madmax` in each
3. Auto-accepts folder trust prompts
4. Waits for readiness, sends each lane's prompt
5. Returns — the agents keep working in the panes for the user to watch
   (omit `--no-monitor` to instead block and print a completion summary)

### Step 3 — Collect (you drive the loop — do NOT go idle)

`--no-monitor` prints the lane→pane map and the exact collect command. Nothing
pushes results to you — **you must actively poll** until every lane is done, then
synthesize (the leader-driven model). Do not stop after launching and wait.

Run the collect command the launcher printed, in a loop:

```bash
omp team collect --worker-pane <id1> --worker-pane <id2> ... --json
```

Each call returns `{ doneCount, total, allDone, lanes: [{ paneId, status, output }] }`
where `status` is `working` | `done` | `dead`. Procedure:

1. Call collect. If `allDone` is false, wait ~20–30s (do a short `sleep 25`) and
   call it again. Keep looping — the workers are running live in the panes.
2. As lanes turn `done`, their `output` holds that worker's final pane text; a
   `dead` lane means its pane exited (note it as failed/needs review).
3. When `allDone` is true, read every lane's `output`, then **synthesize the
   combined results back to the user** (per lane: what it found / produced).

Keep the loop bounded (e.g. stop after ~15 min and report whatever is done).

## Optional mode — Runtime (`omp team`)

Choose this only when the user explicitly wants the team to run in the background or needs runtime features.

### When to choose it

- The user asked for a **background** team
- You need `omp team status`, shutdown, or runtime task APIs
- You do **not** need the panes in the current tmux window

### Launch

```bash
omp team <N>:copilot "<task description>" --name <name>
```

The runtime automatically:
1. Creates a tmux session with split panes
2. Launches `copilot --allow-all-tools` in each pane
3. Auto-accepts folder trust prompts
4. Waits for readiness, then sends the task prompt
5. Tracks task state, heartbeats, and supports idle-nudging

### Monitor and cleanup

```bash
omp team status <name>            # check progress (same <name> passed to --name)
tmux attach -t omp-team-<name>    # watch panes live
omp team shutdown <name>          # kill when done
```

## Prerequisites

- `tmux` installed and session running
- `omp` on PATH
- `jq` for JSON parsing (split mode only)

## Task / prompt guidelines

Each task must be **self-contained**. The agent has no context from this session. Include:
- Exact files or directories to work in
- What to do (fix, upgrade, etc.)
- How to verify (run tests, etc.)
- Commit message to use

### Good example

> In src/auth/login.ts, replace bcrypt with argon2. Update the import, change the verify call, run `npm test -- --grep auth`. Commit: "refactor: switch to argon2".

### Bad example

> Fix the auth module. (Too vague)

## Composition

Use `/ralplan` before `/team` to produce the plan. Use `/verify` after completion.

## Limitations

- Each pane is an independent session — no shared state
- Workers can message each other via `omp team api send-message` (runtime mode only)
- If tasks depend on each other, use `/ralph` instead

## Cost/token note

This skill can drive multiple tool calls or long-running output. Use `omp cost [--today] [--session <id>]` for local hook-ledger estimates only; it is not provider billing. Keep injected summaries concise and prefer bounded output when rerunning noisy commands.
