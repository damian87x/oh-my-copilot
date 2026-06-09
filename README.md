# oh-my-copilot

[![npm version](https://img.shields.io/npm/v/@damian87/omp.svg)](https://www.npmjs.com/package/@damian87/omp)
[![npm downloads](https://img.shields.io/npm/dm/@damian87/omp.svg)](https://www.npmjs.com/package/@damian87/omp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

**Multi-agent orchestration for GitHub Copilot CLI. Zero learning curve.**

_Don't relearn Copilot. Just use omp._

[Quick Start](#quick-start) • [Features](#features) • [In-session shortcuts](#in-session-shortcuts) • [Roadmap](#roadmap) • [Documentation](#documentation)

---

> Now on npm as [`@damian87/omp`](https://www.npmjs.com/package/@damian87/omp). One command and you're running.

## Quick Start

**Step 1: Install**

The shell CLI (`omp`):

```bash
npm i -g @damian87/omp
```

And the in-session skills, as a Copilot CLI plugin:

```bash
copilot plugin marketplace add damian87x/oh-my-copilot
copilot plugin install oh-my-copilot@oh-my-copilot
```

Requires Copilot CLI v1.0.48+. After install, `omp --madmax` works from any shell, and `/omp-autopilot`, `/ralplan`, `/code-review`, `/create-skill`, `/self-evolve`, and the rest are available inside any Copilot session.

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
- **Team-first orchestration** — parallel tmux panes, each running an independent agent session
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
- **19 in-session skills** auto-discovered from `.github/skills/`
- **Smart pipeline routing** — `/research-codebase` → `/ralplan` → `/team` / `/ralph` / `/ultrawork` → `/code-review` → `/ultraqa`

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
| `/team`                 | Parallel tmux agent panes                                 | `/team`                                              |
| `/code-review`          | Diff-focused reviewer                                     | `/code-review`                                       |
| `/weighted-consensus`   | Multi-model council → one weighted verdict + minority report | `/weighted-consensus "JSON or YAML for config?"`  |
| `/research-codebase`    | Map an area of the codebase                               | `/research-codebase "auth middleware"`               |
| `/debug`                | Disciplined diagnose-reproduce-fix loop                   | `/debug "flaky integration test"`                    |
| `/tdd`                  | Red-green-refactor cycle                                  | `/tdd "add pagination to /users"`                    |
| `/verify`               | Exercise a change end-to-end                              | `/verify`                                            |
| `/create-skill`         | Author a new skill                                        | `/create-skill`                                      |
| `/self-evolve`          | Extract a learned skill from this session                 | `/self-evolve`                                       |
| `/jira-ticket`          | Render or apply a Jira ticket payload                     | `/jira-ticket`                                       |
| `/prototype`            | Throwaway prototype to flesh out a design                 | `/prototype "state shape"`                           |
| `/grill-me`             | Stress-test a plan with Socratic questions                | `/grill-me`                                          |
| `/caveman`              | Ultra-compressed communication mode                       | `/caveman`                                           |
| `/worktree`             | Git worktree-based parallel branch work                   | `/worktree`                                          |

---

## Weighted consensus (model council)

`/weighted-consensus` fans a question out to several models **in parallel**, each
running independently with its own role, then a separate synthesizer model merges
their answers into one verdict — treating each member's weight as a **prior**, not
a vote tally — and surfaces a **minority report** instead of averaging dissent away.

It runs as `omp council` under the hood (engine in `src/council/`), so it works
both in-session via the skill and from the shell.

```bash
# Shell — default roster from .omp/config.json (or built-in default)
omp council "Should we adopt a monorepo? One paragraph."

# Pick the roster inline (model:role:weight, or bare models with default roles)
omp council "Is this migration safe?" \
  --models "gpt-5-mini:critic:1.5,gpt-4.1:architect:1" \
  --synth gpt-4.1 --json

# Feed a diff/file as shared context and an evaluation rubric
omp council "Review this change for blockers" --context @diff.txt --rubric @rubric.md
```

In-session, just ask:

```
/weighted-consensus "Should this service use gRPC or REST?"
/weighted-consensus "Compare these two caching strategies" --models gpt-5-mini,gpt-4.1
```

Configure the default roster in `.omp/config.json`:

```json
{
  "council": {
    "synthesizer": "gpt-4.1",
    "minSurvivors": 2,
    "maxConcurrency": 4,
    "members": [
      { "model": "gpt-5-mini", "role": "critic", "weight": 0.4 },
      { "model": "gpt-4.1", "role": "architect", "weight": 0.35 },
      { "model": "gpt-5-mini", "role": "pragmatist", "weight": 0.25 }
    ]
  }
}
```

Notes:
- Members run as independent `copilot --model <X>` processes — none sees the others' answers.
- Unavailable models (not on your Copilot plan) are detected and dropped; the
  council still synthesizes from survivors and fails only below `minSurvivors`.
- For real diversity prefer distinct models; on a free GPT-only plan, distinct **roles** still help (add a Claude/other-provider model if your plan includes one).
- Diversity comes from the model mix + per-role prompts; the Copilot CLI exposes no temperature knob.

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
omp council "<question>" [--models a,b,c] [--context @file] [--json]   # multi-model council
omp comms status | send | recv | ask        # drive a running copilot tmux session
omp gateway serve [--only slack]            # run chat connectors (today: slack)
omp gateway status [--json]                 # per-connector readiness (no sockets)
omp slack serve                             # deprecated alias of `gateway serve --only slack`
omp slack doctor [--json]                   # deprecated alias of `gateway status --only slack`
omp mcp                                     # MCP server over stdio
omp catalog list | validate | capability <id>
omp jira render <plan-file>
omp jira apply <key-or-plan> --comment|--update|--transition|--link
```

Environment overrides:

- `OMP_PLUGIN_ROOT` — path to the plugin checkout (with `OMC_PLUGIN_ROOT` accepted for back-compat)
- `OMP_COPILOT_BIN` — alternate `copilot` binary

### Chat bridge: drive Copilot from Slack

`omp gateway` runs long-lived chat connectors that forward messages into a running
Copilot CLI session (via tmux) and post replies back. Today's connector is `slack`
(WebSocket Socket Mode — no public URL needed); the runtime is generic so future
connectors (Telegram, Discord, webhooks) drop in as one file each.

```bash
# 1. a Copilot tmux session is running (any `omp-<digits>` name)
tmux new-session -d -s omp-9999

# 2. interactive setup — explains where to grab each token and writes
#    ~/.omp/.env (chmod 600). Re-runnable; masks existing values.
#    `omp` auto-loads ~/.omp/.env every invocation; shell exports still win.
omp env init

# 3. preflight, then run
omp gateway status              # ready=true means tokens + session look good
omp gateway serve               # blocks; ^C stops cleanly
```

Full Slack-app setup (manifest + scopes) lives in [`docs/slack-setup.md`](docs/slack-setup.md).

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
npm link                                       # makes `omp` point to your local checkout
npm test
npm run lint:skills
npm run sync:dry-run
```

After `npm link`, the global `omp` command runs your local build. Any changes you make are reflected after `npm run build`.

To unlink and revert to the published package:

```bash
npm unlink -g @damian87/omp
npm i -g @damian87/omp
```

## Releasing (maintainers)

One command runs the whole flow — quality gates → version bump → tag → push →
GitHub release → `npm publish`. It's a maintainer script (`tools/release.sh`),
**not** a published plugin skill, so it never ships in the package or appears in
the in-session skill catalog. npm 2FA is on, so pass an authenticator code via `--otp`.

```bash
npm run release -- minor --otp 123456     # bump 0.x.0, tag, push, GH release, publish
npm run release -- patch --dry-run        # validate everything, change nothing
npm run release:publish-only -- --otp 123456   # build + publish the CURRENT version (recover a half-done release)
```

The script refuses to run unless you're on a clean, up-to-date `main` and the
gates (`test`, `lint:skills`, `check:catalog`, `build`) pass.
