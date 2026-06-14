---
name: jira-ticket
description: Prepare Jira create, comment, and safe-update payloads with safe dry-run fallback. Use with /jira-ticket when work tracking is requested.
---

# Jira Ticket

Use `/jira-ticket` when work tracking is requested.

## When to use

- A plan or completed work needs a Jira ticket
- You need to comment on or update an existing ticket
- The user wants a ticket draft without actually creating it

## Operations

### Create
- Build from an approved plan or implementation slice (a plan file or markdown)
- Include: Summary, Description, Acceptance Criteria
- Render the payload with `omp jira render <plan-file>` — this **never** writes to Jira. To create/comment/update, run `omp jira apply <plan-file-or-ticket-key>`, which defaults to **dry-run** and only writes when Jira is configured with `JIRA_MODE=live` and the user has explicitly confirmed.

### Comment
- Add implementation evidence, verification results, or status updates
- Format for readability (use Jira wiki markup, not Markdown)
- Apply with `omp jira apply <ticket-key> --comment` (dry-run by default; preview before confirming)

### Safe update
- Only update known simple fields (summary, description, labels)
- Apply with `omp jira apply <ticket-key> --update` (dry-run by default)
- Do not guess transitions, issue links, project keys, or secrets

## Rules

- Always preview with `omp jira render` or `omp jira apply … --dry-run` (the default) before any live write
- If Jira config is missing, the commands stay in dry-run and print the payload — never fail silently
- Do not guess project keys, transitions, or credentials
- Keep acceptance criteria testable and specific
- Include file paths and evidence when commenting with implementation details

## Output

- `Operation` — create / comment / update
- `Target` — ticket key or "new"
- `Payload` — the Jira-formatted content
- `Human action` — what the user needs to do (e.g. "paste into Jira" if dry-run)
