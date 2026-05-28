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
- Build from an approved plan or implementation slice
- Include: Summary, Description, Acceptance Criteria
- If Jira config is available, create via API; otherwise output a dry-run payload

### Comment
- Add implementation evidence, verification results, or status updates
- Format for readability (use Jira wiki markup, not Markdown)

### Safe update
- Only update known simple fields (summary, description, labels)
- Do not guess transitions, issue links, project keys, or secrets

## Rules

- If Jira config is missing, always output a **dry-run payload** — never fail silently
- Do not guess project keys, transitions, or credentials
- Keep acceptance criteria testable and specific
- Include file paths and evidence when commenting with implementation details

## Output

- `Operation` — create / comment / update
- `Target` — ticket key or "new"
- `Payload` — the Jira-formatted content
- `Human action` — what the user needs to do (e.g. "paste into Jira" if dry-run)
