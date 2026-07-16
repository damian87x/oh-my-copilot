# Issue tracker: Jira (wayfinder operations)

Use only after the human confirms **tracker = jira** and a **project key** (see SKILL.md "Confirm tracker destination first").

Prefer `omp jira` / `/jira-ticket` over inventing REST calls. Live writes need `JIRA_MODE=live`, configured credentials, and **explicit user confirmation** per write batch. Default is dry-run / fallback payload.

Config discovery: `JIRA_BASE_URL` / `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, optional `JIRA_DEFAULT_ISSUE_TYPE`. See repo `docs/jira.md` when the skill runs inside oh-my-copilot.

## Labels → Jira labels

Map wayfinder types to Jira **labels** (not GitHub labels):

| Wayfinder | Jira labels |
|-----------|-------------|
| map | `wayfinder-map` |
| research | `wayfinder-research` |
| prototype | `wayfinder-prototype` |
| grilling | `wayfinder-grilling` |
| task | `wayfinder-task` |

Create map/tickets with those labels in the create payload. Do not invent components or custom fields unless the human names them.

## Map

1. Build a ticket file (summary + description with the standard map sections + `tracker: jira` / `pin: KEY` in Notes — same keys as SKILL.md).
2. Preview: `omp jira render <map-plan.md>`
3. Create only after user confirms live: `omp jira apply <map-plan.md>` (or paste fallback if dry-run).

Map body sections stay the same Markdown as GitHub (`## Destination`, `## Notes`, …) inside the Jira description (wiki markup if the site requires it — keep sections readable).

When subtask/parent links are unavailable, listing children in the map description is an intentional fallback (otherwise open tickets stay off the map body).

## Child ticket

1. Create with the appropriate `wayfinder-*` label and `## Question` body.
2. **Link to map** via `omp jira apply <child> --link` with `--link-target <MAP-KEY>` only when link type is discovered/configured. Prefer "is blocked by" / "Relates" only after discovery — **no guessing** link type names.
3. Fallback: put `Part of <MAP-KEY>` at the top of the child description and list children under a task list in the map description.

## Blocking

Native GitHub deps do not apply. Prefer:

1. Jira issue links of type **Blocks** / **is blocked by** after discovery confirms the type exists.
2. Fallback line at top of child description: `Blocked by: KEY-1, KEY-2` (open = not Done/Closed).

Unblocked when every blocker is in a terminal done status the project uses (ask the human once; record in Notes as `done_statuses: ...`).

## Frontier query

1. List open issues in the project with map linkage (subtask/parent, Relates, or `Part of` text) — use JQL the human approves covering **all** wayfinder child types, e.g. `project = KEY AND labels in (wayfinder-research, wayfinder-prototype, wayfinder-grilling, wayfinder-task) AND statusCategory != Done ORDER BY created ASC` (explicit sort approximates map order).
2. Drop items with open blockers or an assignee (claimed).
3. First remaining in that ordered list wins.

Do not invent broad JQL that mutates or bulk-closes.

## Claim

Assign the ticket to the driving user **before work** (Jira assignee = claim). Unassigned = unclaimed. Use safe update / UI if API assignee field is not in the safe-update set — ask human to assign if CLI cannot.

## Resolve

1. Comment with the answer (preview dry-run first).
2. Transition to a done status only after discovery matches the exact transition — else leave open and ask the human to close, or put close instruction in fallback.
3. Append one Decisions-so-far line on the **map** description (read-modify-write the map issue description).

## Honesty limits (v1)

- omp Jira phase-1 is safest for **create / comment / safe field update**; transitions and links are discovery-gated.
- If live charting is blocked by dry-run-only config, produce the full payload set and stop — do not fake issue keys.
- Never open GitHub issues "as a fallback" after the human chose Jira.
