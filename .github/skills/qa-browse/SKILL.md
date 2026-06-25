---
name: qa-browse
description: Drive a real browser from the CLI to QA a flow — navigate, click, fill, verify. Uses @playwright/cli (token-efficient, not MCP). Use with /qa-browse when the user wants to manually check a web flow works, not write a test suite.
argument-hint: "<url> <what to verify>"
---

# QA Browse — CLI browser driving with @playwright/cli

`/qa-browse` opens a live browser via the official Playwright CLI and walks a flow to verify it works. No test files. No MCP.

Engine: `@playwright/cli` (Microsoft). Snapshots live on disk, not in context — cheap tokens. Browser stays alive between commands.

## Rules

- Use `npx playwright-cli` if not installed globally. Never assume global.
- Loop: **snapshot → read refs → act → re-snapshot.** Always.
- Refs (`e5`, `e12`) are valid only for the latest snapshot. Re-snapshot after any navigation/click that changes the page.
- Headless by default. Add `--headed` only when a human must watch.
- Prefer refs over CSS. Use `getByRole`/`getByText` selectors only if a ref isn't available.
- Verify with `eval` or a snapshot of the result region — don't assume an action worked.
- Screenshot on each pass/fail checkpoint so there's evidence.
- `close` when done.

## Setup

```bash
npm install -g @playwright/cli@latest   # or use: npx playwright-cli
npx playwright-cli install chromium      # first run in a fresh env
```

## Core loop

```bash
playwright-cli open <url>        # open + navigate (prints a snapshot path)
playwright-cli snapshot          # accessibility tree with refs → read it
playwright-cli click e15         # act using a ref
playwright-cli fill e5 "text"    # fill input (add --submit to press Enter)
playwright-cli type "text"       # type into focused element
playwright-cli press Enter       # key press
playwright-cli snapshot          # re-snapshot to confirm new state
playwright-cli screenshot        # evidence
playwright-cli close
```

## Interact

```bash
playwright-cli click <ref> [button]     # left/right/middle
playwright-cli dblclick <ref>
playwright-cli fill <ref> <text> --submit
playwright-cli select <ref> <value>     # dropdown
playwright-cli check <ref> / uncheck <ref>
playwright-cli hover <ref>
playwright-cli drag <startRef> <endRef>
playwright-cli upload ./file.pdf
playwright-cli dialog-accept / dialog-dismiss
```

## Navigate

```bash
playwright-cli goto <url>
playwright-cli go-back / go-forward / reload
```

## Inspect & verify

```bash
playwright-cli snapshot --depth=4          # shallow tree on big pages
playwright-cli snapshot e34                 # drill into a subtree
playwright-cli snapshot --raw | grep button # script-friendly
playwright-cli eval "document.title"        # read page state
playwright-cli eval "el => el.textContent" e5
playwright-cli eval "el => el.getAttribute('data-testid')" e5
playwright-cli console                       # console messages
```

## Evidence

```bash
playwright-cli screenshot                    # full page
playwright-cli screenshot e5                 # one element
playwright-cli screenshot --filename=step1.png
playwright-cli video-start / video-stop
playwright-cli tracing-start / tracing-stop  # open in trace viewer
playwright-cli pdf --filename=page.pdf
```

## Sessions

State (cookies, localStorage) persists within a session across commands.

```bash
playwright-cli --session=qa open <url>       # named session
playwright-cli -s=qa open <url> --persistent # save profile to disk
playwright-cli list                          # running sessions
playwright-cli show                          # live dashboard, take over mouse/kbd
playwright-cli close-all / kill-all
```

## QA flow checklist

1. `open <url>` → `snapshot`.
2. For each step: find ref in snapshot → act → re-snapshot → verify expected element/text.
3. `screenshot` at each checkpoint (pass and fail).
4. On failure: `eval` the element, capture `console`, take a `--headed` re-run or trace.
5. Report: what passed, what failed, with screenshot/snapshot paths. `close`.

## Example — login flow

```bash
playwright-cli open https://app.example.com/login
playwright-cli snapshot
playwright-cli fill e1 "user@example.com"
playwright-cli fill e2 "secret" --submit
playwright-cli snapshot                       # expect dashboard
playwright-cli eval "document.title"
playwright-cli screenshot --filename=logged-in.png
playwright-cli close
```

## When NOT to use

- Want a saved, repeatable test suite → use `/tdd` or write `@playwright/test` specs.
- Need long-running autonomous loops or persistent introspection → Playwright MCP may fit better.
