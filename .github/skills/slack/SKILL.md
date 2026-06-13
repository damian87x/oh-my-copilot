---
name: slack
description: Post an outbound Slack notification — ONLY when the user types the explicit `/slack` slash command. Never auto-trigger from natural-language phrases like "tell Slack" or "notify me on Slack"; those go to the regular chat. One-way (publish only); the v0.8.0 gateway bridge still handles bidirectional DM chat.
argument-hint: "<message> [--target slack:C…|D…|G…|U…]"
---

# /slack — outbound Slack notification

Post a single message to Slack and exit. **No conversation; no listener.** The
v0.8.0 chat bridge (`omp gateway serve` + `@omp-copilot` DM) handles bidirectional
chat; this skill is for one-shot publishes.

## Activation rules (read first)

- **Activate ONLY** when the user typed the literal slash command `/slack` (with or
  without arguments). Never auto-activate from natural-language phrases like "tell
  Slack X", "ping me on Slack", "notify me on Slack" — those are conversational.
- **Confirm the destination before posting**, every time:
  - If `--target` is present, echo it back: "Sending to `slack:<ID>` — confirm? (y/N)"
  - If `--target` is absent AND `SLACK_HOME_CHANNEL` is a channel (`C…`/`G…`):
    treat as a potential broadcast. Ask: "Post to default channel `<id>` (a channel,
    not a DM)? (y/N)" — only proceed on explicit `y`.
  - If `SLACK_HOME_CHANNEL` is a user (`U…`) or DM (`D…`), proceed without
    confirmation — the user already configured a personal default.
- If the user types just `/slack` with no message, ask: *"What should I send and where?"*.

## Contract

- Default target = `SLACK_HOME_CHANNEL` from `~/.omp/.env` (set via `omp env init`).
- Explicit target = `--target slack:<ID>` (ID = `C…`/`G…`/`D…`/`U…`).
- `U…` targets are auto-resolved to a DM channel (`conversations.open`) before posting.
- Stateless: each invocation is a fresh REST call to `chat.postMessage`. No daemon. No socket.

## When invoked

Follow the **Activation rules** above. After confirmation passes, post the message.

## How

Run via the omp CLI:

```
omp gateway notify --text "<message>" [--target slack:<ID>] [--thread-ts <ts>]
```

That's the only command this skill drives. The flags map 1:1 to user intent:

- No flags after `--text`: post to `SLACK_HOME_CHANNEL`.
- `--target slack:C0BOQV5434G`: explicit channel.
- `--target slack:U0123ABCD`: explicit user (auto-DM).
- `--target slack:C0…:1700.000123` or `--thread-ts 1700.000123`: pin to a thread.

## Output handling

The CLI returns a structured result:

- Success: `posted to <channel> (ts=<ts>[, opened IM])` — relay that.
- Failure: `notify failed [<CODE>]: <reason>` — surface the code + reason so the user
  can act. Common codes:
  - `MISSING_TEXT` — the message body was empty; pass a non-empty `--text`.
  - `MISSING_TOKEN` — run `omp env init` to set `SLACK_BOT_TOKEN`.
  - `MISSING_TARGET` — pass `--target` or run `omp env init` to set `SLACK_HOME_CHANNEL`.
  - `BAD_TARGET` / `BAD_HOME_CHANNEL` — the ID is malformed; show the user the expected shape.
  - `OPEN_FAILED` (user-id targets) — bot can't DM that user (likely missing `im:write` scope or user outside workspace).
  - `POST_FAILED` — Slack returned `ok: false`; the reason field has Slack's own error name (`channel_not_found`, `not_in_channel`, etc.).
  - `RATE_LIMITED` / `TIMEOUT` / `NETWORK_ERROR` — transient; try again.

## Boundaries

- This skill **never** waits for a reply. For interactive chat, the user opens Slack and DMs `@omp-copilot` (handled by `omp gateway serve`).
- This skill **never** stores state. There is no routing table, no per-session registration.
- This skill **does not** start the v0.8.0 inbound bridge. Daemons stay out of scope.

## Example exchanges

User: `/slack the migration just finished cleanly`
Tool call: `omp gateway notify --text "the migration just finished cleanly"`

User: `/slack tell #releases the build is green --target slack:C0RELEASE9`
Tool call: `omp gateway notify --text "the build is green" --target slack:C0RELEASE9`

User: `/slack ping U0123ABCD with "deploy needs review"`
Tool call: `omp gateway notify --text "deploy needs review" --target slack:U0123ABCD`
