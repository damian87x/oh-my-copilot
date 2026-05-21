---
name: jira-ticket
description: Prepare or apply Jira create, comment, and safe-update operations when work tracking is requested; fall back to dry-run payloads when configuration is missing.
---

# Jira Ticket

Use Jira only when the user asks for work tracking or an approved workflow requires it.

## Configuration order

1. External/global Jira configuration exposed to the provider.
2. Environment variables such as `JIRA_BASE_URL` or `JIRA_SITE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY`.
3. Repo `.env` fallback using the same variable names.

Never print or commit secrets. Reference secret variable names instead.

## MVP operations

- Create an issue from an approved plan or vertical slice.
- Add a comment containing implementation or verification evidence.
- Safely update simple fields such as summary, description, labels, configured components, configured priority, or acceptance criteria when the issue key is known.
- For transitions and issue links, discover valid IDs/types before applying; otherwise emit fallback payloads.

## Fallback

If Jira is not configured or an operation is unavailable, produce:

~~~md
## Jira fallback: <operation>
Reason: <why live operation was not run>
Target: <ticket key or new issue>
Payload:
```json
{ ...exact Jira REST-style payload with secrets redacted... }
```
Human action:
<one concise instruction>
~~~
