---
name: team
description: Split an approved plan into parallel tmux panes, each running an independent Copilot CLI agent. Use when work has independent lanes and you want visual parallel execution in split terminals. Use when user says /team, team, or wants parallel agent execution.
---

# Team — tmux-based parallel agent execution

`/team` splits work into parallel tmux panes in the **current window**, each running an independent interactive agent session. You see all agents working side-by-side immediately.

## When to use

- Work has **independent lanes** (no shared files, no ordering constraints)
- You want visual, demo-friendly parallel execution in split terminals

## Agent execution steps (FOLLOW EXACTLY)

When `/team` is invoked, you MUST execute these steps in order:

### Step 1 — Identify lanes

Collect independent work lanes from the conversation context. Each lane needs:
- `id`: short kebab-case identifier (e.g. `lane-a`, `fix-auth`)
- `name`: human-readable name (e.g. `Upgrade dependencies`)
- `prompt`: complete task prompt — must be self-contained with all context the agent needs (files to change, what to do, commit message)

If no plan or lanes exist yet, ask the user what work to split.

### Step 2 — Write lanes JSON

Write a temporary lanes file at `/tmp/team-lanes-<timestamp>.json`:

```json
[
  {
    "id": "lane-a",
    "name": "Short descriptive name",
    "prompt": "Complete self-contained task prompt for the agent..."
  },
  {
    "id": "lane-b",
    "name": "Another lane name",
    "prompt": "Another complete task prompt..."
  }
]
```

### Step 3 — Launch the team

Run the launch script, passing the session name and lanes file path:

```
.github/skills/team/scripts/team-launch.sh --session "team-<name>" --lanes <lanes-file>
```

This will:
- Split the **current tmux window** into panes (leader keeps its pane)
- Launch `omp --madmax` interactively in each pane, then send the prompt
- Arrange panes in a tiled grid layout
- Print pane IDs and navigation commands

### Step 4 — Report to user

Show the user:
- Which panes were created and what each is working on
- Navigation: `Ctrl-b + arrow keys` to move between panes
- How to check output: `tmux capture-pane -t <pane-id> -p -S -50`
- How to kill panes when done

## Prerequisites

- `tmux` installed and running inside a tmux session
- `omp` (oh-my-copilot) on PATH — preferred, launches with `omp --madmax`
- Falls back to `copilot` if `omp` is not available
- `jq` for JSON parsing

## Prompt guidelines

Each lane prompt must be **self-contained**. The agent in that pane has no context from this session. Include:
- Exact files or directories to work in
- What to do (fix, upgrade, accept, etc.)
- How to verify (run tests, npm audit, etc.)
- Commit message to use

## Limitations

- Each pane is an independent agent session — no shared state
- Agents cannot communicate with each other
- Leader (you) must manually verify results after all panes complete
- Best for independent, non-conflicting work streams
