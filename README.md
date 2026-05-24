# oh-my-copilot

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Multi-agent orchestration for GitHub Copilot CLI. Zero learning curve.**

_Don't relearn Copilot. Just use omp._

[Quick Start](#quick-start) • [Features](#features) • [In-session shortcuts](#in-session-shortcuts) • [Roadmap](#roadmap) • [Documentation](#documentation)

---

## Quick Start

**Step 1: Install**

Two commands install all 17 omp skills as a Copilot CLI plugin:

```bash
copilot plugin marketplace add damian87x/oh-my-copilot
copilot plugin install oh-my-copilot@oh-my-copilot
```

Requires Copilot CLI v1.0.48+. After install, `/omp-autopilot`, `/ralplan`, `/code-review`, `/create-skill`, `/self-evolve`, and the rest are available inside any Copilot session.

If you prefer the npm path for the local runtime:

```bash
npm i -g oh-my-copilot
```

**Step 2: Build something**

```bash
# Bare-flag launch with permissions bypass (alias of copilot --yolo)
omp --madmax -p "build a REST API for managing tasks"

# Or via in-session skill
/omp-autopilot "build a REST API for managing tasks"
```

That's it.

---

## Why oh-my-copilot?

- **Zero configuration** — works out of the box with sane defaults
- **Team-first orchestration** — staged pipelines on a shared task list
- **Bare-flag bypass** — `omp --madmax` injects `--yolo` so non-interactive runs never block on a permission prompt
- **Persistent execution** — Ralph, UltraQA, and Ultrawork keep going until the goal is verified
- **MCP-powered shared state** — workers swap typed messages over an outbox/inbox cursor instead of summarising each other's summaries
- **Lifecycle hooks** — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`, `Error`
- **Doctor included** — `omp doctor` verifies plugin manifest, skills discovery, hooks, and the underlying `copilot` CLI in one shot

---

## Features

### Orchestration Modes

| Mode                 | What it is                                                       | Best for                                       |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| **Team**             | tmux CLI workers on a shared task list with file-state outbox    | Coordinated parallel work on one objective     |
| **Autopilot**        | Single-lead autonomous loop (`/omp-autopilot`)                   | End-to-end feature work with minimal ceremony  |
| **Ralph**            | Persistent verify/fix loop with explicit reviewer                | Tasks that must complete fully (no partials)   |
| **Ultrawork**        | Maximum parallelism for fan-out tasks                            | Burst parallel fixes / refactors               |
| **UltraQA**          | QA cycling until tests/build/lint/typecheck all pass             | Quality gates needing repeat diagnose/fix      |
| **Ralplan**          | Consensus planning step before any loop                          | Vague requests that need decomposition first   |
| **Madmax (CLI)**     | `omp --madmax …` — bypass permissions for non-interactive runs   | Scripted / automated copilot invocations       |

### Intelligent Orchestration

- **7 specialized agents** — planner, architect, executor, verifier, code-reviewer, designer, researcher (all `--agent <name>` compatible with Copilot CLI)
- **17 in-session skills** auto-discovered from `.github/skills/`
- **Smart pipeline routing** — `/codebase-research` → `/ralplan` → `/team` / `/ralph` / `/ultrawork` → `/code-review` → `/ultraqa`

### Developer Experience

- **MCP server** ships with `notepad`, `project-memory`, `shared-memory`, `state`, and `trace` tools out of the box
- **File-state coordination** — outbox JSONL + byte cursor, atomic `O_EXCL` task locks, optimistic CAS on claim
- **Idle nudge** — content-based pane idle detection that pokes stuck workers
- **Mode-state loops** — single source of truth per loop (Ralph/Ultrawork/UltraQA state files)

---

## In-session shortcuts

These run **inside a Copilot CLI session** after the plugin is installed.

| In-session form         | Effect                                                    | Example                                              |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `/omp-autopilot`        | Full autonomous execution                                 | `/omp-autopilot "build a todo app"`                  |
| `/ralph`                | Persistence mode                                          | `/ralph "refactor auth"`                             |
| `/ultrawork`            | Maximum parallelism                                       | `/ultrawork "fix all type errors"`                   |
| `/ultraqa`              | QA cycling until goal met                                 | `/ultraqa "build green, tests pass"`                 |
| `/ralplan`              | Consensus planning                                        | `/ralplan "plan this feature"`                       |
| `/team`                 | Coordinated multi-agent task list                         | `/team 3:executor "ship the migration"`              |
| `/code-review`          | Diff-focused reviewer                                     | `/code-review`                                       |
| `/codebase-research`    | Map an area of the codebase                               | `/codebase-research "auth middleware"`               |
| `/debug`                | Disciplined diagnose-reproduce-fix loop                   | `/debug "flaky integration test"`                    |
| `/tdd`                  | Red-green-refactor cycle                                  | `/tdd "add pagination to /users"`                    |
| `/verify`               | Exercise a change end-to-end                              | `/verify`                                            |
| `/create-skill`         | Author a new skill                                        | `/create-skill`                                      |
| `/self-evolve`          | Extract a learned skill from this session                 | `/self-evolve`                                       |
| `/jira-ticket`          | Render or apply a Jira ticket payload                     | `/jira-ticket`                                       |
| `/prototype`            | Throwaway prototype to flesh out a design                 | `/prototype "state shape"`                           |
| `/grill-me`             | Stress-test a plan with Socratic questions                | `/grill-me`                                          |
| `/caveman`              | Ultra-compressed communication mode                       | `/caveman`                                           |

---

## Terminal CLI

```bash
omp --help
omp version
omp doctor                                  # verify install + copilot binary
omp list                                    # show discovered skills and agents
omp setup [--dry-run] [--scope project|user]
omp launch -- [copilot flags…]              # forward arbitrary args to copilot
omp --madmax -p "edit src/foo.ts"           # bare-flag, maps to copilot --yolo
omp team 3:executor "fix all type errors"   # spawn tmux workers
omp team status <name>
omp team shutdown <name>
omp ralph start "<task>" [--max-iterations N]
omp ultrawork start "<objective>" [--task-count N]
omp ultraqa start "<goal>" [--max-cycles N]
omp mcp                                     # MCP server over stdio
omp catalog list | validate | capability <id>
omp jira render <plan-file>
omp jira apply <key-or-plan> --comment|--update|--transition|--link
```

Environment overrides:

- `OMP_PLUGIN_ROOT` — path to the plugin checkout (with `OMC_PLUGIN_ROOT` accepted for back-compat)
- `OMP_COPILOT_BIN` — alternate `copilot` binary

---

## Roadmap

omp is intentionally small today and growing in vertical slices.

### v0.2 — Notification gateways

Telegram, Discord, Slack, and generic webhook integration so long-running modes can ping you when they finish, fail, or stall. Tag with `--telegram` / `--discord` / `--slack` per invocation; configure once with `omp notify add`.

### v0.3 — Checkpoints + rollback

Auto-snapshot the working tree before any tool-driven file edit. `omp rollback [id]` to revert a checkpoint. A safety net for autonomous loops that go wide before they go right.

### v0.4 — Provider advisor (`omp ask`)

One command to consult an alternate provider CLI (`claude`, `codex`, `gemini`) and save the response as a markdown artifact under `.omp/artifacts/ask/`. Same surface in-session via `/ask`.

### v0.5 — Scheduled tasks

Natural-language cron: `omp schedule "every weekday 9am run /code-review on main"`. Jobs can attach skills, deliver results to a notification gateway, and support pause/resume/edit. Built on the same mode-state primitives Ralph and UltraQA use.

### v0.6 — Browser tool (MCP)

A first-class browser MCP tool: web search, page extraction, full automation (navigate, click, type, screenshot). For research skills that need fresh data instead of training-cutoff guesses.

### v0.7 — HUD-lite statusline

Live orchestration metrics in the terminal: active mode, current task, worker count, tokens, cache hit rate, last error.

### v0.8 — Provider routing

Fine-grained per-task provider selection — sorting, whitelists, priority ordering, cost-aware fallback. For mixed pipelines that want Opus for planning and Haiku for grunt work without manual model switching.

### v0.9 — Skill learning

Extract repeating patterns from session transcripts into reusable skill files with strict quality gates. Auto-injects into context when relevant triggers fire.

### v1.0 — Pre-built agent templates

One-shot deployable templates for common workflows: research, security audit, design-system migration, content automation. `omp template add <name>` drops a curated skill + agent pair into your project.

---

## Documentation

- [General skills](docs/general-skills.md) — slash-skill layout, capability IDs, portability rules
- [Copilot distribution](docs/copilot-distribution.md) — project/user skill installs and the case against GitHub App Extensions
- [Jira adapter](docs/jira.md) — configuration discovery, safe operations, dry-runs, fallback payloads
- [Self-evolve](docs/self-evolve.md) — extracting reusable skills from session transcripts

## Layout

```text
.github/agents/<name>.md          # custom agents discoverable via --agent
.github/skills/<name>/SKILL.md    # in-session slash skills
hooks/hooks.json                  # lifecycle hook manifest
scripts/*.mjs                     # hook implementations
src/                              # omp CLI, MCP server, team runtime, mode-state loops
```

Skills follow the [Copilot agent-skills docs](https://docs.github.com/en/copilot) — project skills live in `.github/skills/` and are invoked with `/skill-name`.

---

## Local development

```bash
npm install
npm run build
npm test                                       # 137 tests
npm run lint:skills
npm run sync:dry-run
npx tsx src/cli.ts skill install .github/skills/create-skill --dry-run
```
