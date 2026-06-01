---
name: team
description: Split an approved plan into parallel tmux panes, each running an independent Copilot CLI agent. Use when work has independent lanes and you want visual parallel execution in split terminals. Use when user says /team, team, or wants parallel agent execution.
argument-hint: "<number of lanes or plan reference>"
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

Run the launch script using its **full installed path**:

```bash
bash ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/.github/skills/team/scripts/team-launch.sh \
  --session "team-<name>" --lanes <lanes-file>
```

> **Important:** Use the full path above — the script lives in the plugin install directory, not the project repo.

The script handles the full lifecycle automatically:
1. Splits the **current tmux window** into panes
2. Launches `omp --madmax` (or `copilot`) in each pane
3. **Auto-accepts folder trust prompts** if they appear
4. **Waits for each agent to be ready** (polls for the `/ commands` status bar)
5. **Sends prompts** via `send-keys -l` (literal) + Enter
6. **Monitors completion** — detects when each agent returns to idle
7. **Prints a results summary** with notable output from each pane

### Step 4 — Report to user

The script prints all results directly. Just relay the output to the user. If any agents timed out or failed, note which ones.

## Prerequisites

- `tmux` installed and running inside a tmux session
- `omp` (oh-my-copilot) on PATH — preferred, launches with `omp --madmax`
- Falls back to `copilot` if `omp` is not available
- `jq` for JSON parsing

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TEAM_POLL_INTERVAL` | `2` | Seconds between readiness/completion polls |
| `TEAM_MAX_READY_WAIT` | `60` | Max seconds to wait for agent CLI to start |
| `TEAM_MAX_COMPLETION_WAIT` | `300` | Max seconds to wait for agents to finish |

## Prompt guidelines

Each lane prompt must be **self-contained**. The agent in that pane has no context from this session. Include:
- Exact files or directories to work in
- What to do (fix, upgrade, accept, etc.)
- How to verify (run tests, npm audit, etc.)
- Commit message to use

### Good prompt example

> You are working in /Users/me/project. In src/auth/login.ts, replace the bcrypt password check with argon2. Update the import, change the verify call, and run `npm test -- --grep auth` to confirm. Commit with message "refactor: switch password hashing to argon2".

### Bad prompt example

> Fix the auth module. (Too vague — which file? What fix? How to verify?)

## Composition

Use `/ralplan` before `/team` to produce the plan that defines lanes. Use `/verify` after all panes complete to confirm combined results don't conflict.

## Limitations

- Each pane is an independent agent session — no shared state or messaging
- Agents cannot communicate with each other — if tasks depend on each other, use `/ralph` instead
- Leader (you) must manually verify results after all panes complete
- Best for independent, non-conflicting work streams
