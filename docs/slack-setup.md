# Slack → Copilot bridge (`omp gateway`)

Drive a running GitHub Copilot CLI session from Slack: DM the bot (or @mention it in a
channel) and it forwards your message to Copilot over the `comms`/tmux bridge, then posts
Copilot's reply back **in-thread**.

It uses **Socket Mode**, so it needs **no public URL** — it runs from your laptop behind NAT.

Slack is the first connector that runs under the generic `omp gateway` runtime. Future
connectors (Telegram, Discord, webhooks) plug into the same `gateway serve` command.

## 1. Create the Slack app (from manifest)

Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest** → pick your
workspace → paste this YAML:

```yaml
display_information:
  name: omp-copilot
  description: Bridge to a local GitHub Copilot CLI session
features:
  bot_user:
    display_name: omp-copilot
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - im:history
      - im:read
      - im:write
      # add channels:history only if you also want channel @mentions in public channels
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
```

## 2. Get the two tokens

- **App-level token (xapp-…)** — *Basic Information → App-Level Tokens → Generate* with scope
  **`connections:write`**. This is `SLACK_APP_TOKEN` (Socket Mode).
- **Bot token (xoxb-…)** — *Install App* to your workspace, then *OAuth & Permissions →
  Bot User OAuth Token*. This is `SLACK_BOT_TOKEN`.

(Optional) find your own Slack user ID (profile → ⋯ → Copy member ID, `U…`) to lock the bot to
just you via `SLACK_ALLOWED_USERS`.

## 3. Run the bridge

The bridge talks to Copilot through the `comms` layer, so a Copilot tmux session must be
running first.

```bash
# Terminal A — a running Copilot session (or `omp` to launch one)
tmux new-session -d -s omp-9999    # any omp-<digits> name; or run: omp

# Terminal B — write ~/.omp/.env once, then run the gateway.
#
# `omp env init` is interactive: it prints the exact Slack-admin pages to
# pull each token from, prompts you, and writes ~/.omp/.env (chmod 600).
# `omp` then auto-loads that file on every invocation — no `source` step.
# Shell exports always win, so a one-off override like
# `SLACK_BOT_TOKEN=other omp gateway serve` still works.
omp env init

# Re-running shows masked existing values and asks before overwriting.
#
# Scripted form (CI, automation) — PREFER env vars over flags so tokens
# never land in shell history, `ps`, or CI logs:
#   OMP_INIT_BOT_TOKEN=xoxb-… OMP_INIT_APP_TOKEN=xapp-… \
#     OMP_INIT_SESSION=omp-9999 OMP_INIT_USERS=U1,U2 \
#     omp env init --force
# (--bot-token / --app-token still work but emit a stderr warning;
#  silence it with OMP_INIT_NO_WARN=1 only when you know it's safe.)

omp gateway serve                       # auto-loads ~/.omp/.env first
```

Alternative: shell exports still work for CI or one-off sessions:
```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
omp gateway serve
```

To restrict the gateway to a subset of connectors (useful when more connectors land):
```bash
omp gateway serve --only slack
```

Preflight without connecting:
```bash
omp gateway status          # per-connector readiness: tokens present + copilot session resolvable
omp gateway status --json   # machine-readable; exit 0 when ready
```

`omp slack serve` and `omp slack doctor` still work as **deprecated aliases** that forward
to `omp gateway serve --only slack` and `omp gateway status --only slack` — so any existing
scripts keep running.

## 4. Use it

- **DM** the bot: `what files changed in the last commit?` → Copilot's answer threads back.
- **@mention** in a channel the bot is in: `@omp-copilot summarize this repo`.

## Behavior

- DMs always respond; channels respond only on @mention (set `SLACK_REQUIRE_MENTION=false` to
  respond to every channel message the bot can see).
- Non-allowlisted users are silently ignored (when `SLACK_ALLOWED_USERS` is set and not `*`).
- Errors come back as friendly replies: no running Copilot session, offline, Copilot busy, or
  a timeout note if Copilot is still working.
- Replies post in the message's thread (`thread_ts`).

## Config reference

| Env var | Required | Meaning |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot token `xoxb-…` |
| `SLACK_APP_TOKEN` | yes | App-level token `xapp-…` (scope `connections:write`) |
| `SLACK_ALLOWED_USERS` | no | CSV of user IDs; `*` or unset = everyone |
| `SLACK_REQUIRE_MENTION` | no | `true` (default) / `false` — require @mention in channels |
| `COPILOT_TMUX_SESSION` | no | Pin the Copilot session; otherwise auto-discovered |

## Notes / limits (v1)

- Inbound chat only (Slack → Copilot → reply). Outbound notifications are a future addition.
- `SLACK_REQUIRE_MENTION=false` currently has no effect in **channels**: v1 only subscribes to
  DMs (`message.im`) and `app_mention`, so non-mention channel messages are never delivered to the
  bot. (Responding to every channel message would need the `channels:history` scope and a
  `message.channels` subscription — a future addition.) It works as expected in DMs.
- One Copilot session at a time (multiple `omp-<digits>` sessions → the bridge reports the
  ambiguity and asks you to pin `COPILOT_TMUX_SESSION`).
- `omp gateway serve` is a long-running foreground process — run it under tmux/systemd to keep it up.
