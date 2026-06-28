# Jira MVP Adapter

The Jira adapter turns a resolved plan or handoff into Jira-ready payloads. It supports credential-free dry-runs and only performs live writes when configuration is present and a Jira action is requested by the user or workflow.

## Configuration discovery

Configuration is resolved in this order:

1. External/global Jira setup available to the host environment.
2. Repository `.env` and process environment variables.
3. Explicit CLI/session flags as overrides.

Supported environment names include:

| Variable | Purpose |
| --- | --- |
| `JIRA_BASE_URL` or `JIRA_SITE_URL` | Jira site URL. |
| `JIRA_EMAIL` | Account email for API auth. |
| `JIRA_API_TOKEN` | API token. Never commit this value. |
| `JIRA_PROJECT_KEY` | Default project key for new issues. |
| `JIRA_DEFAULT_ISSUE_TYPE` | Optional issue type, defaulting to `Task`. |
| `JIRA_COMPONENTS` | Optional comma-separated components for safe updates. |
| `JIRA_PRIORITY` | Optional priority name for create/update payloads. |

If required config is missing, commands print fallback payloads instead of guessing or failing silently.

## Supported operations

Phase 1 supports these safe operations:

- Create issue payloads from plans/handoffs.
- Add comments to existing issues.
- Safely update summary, description, labels, configured components, configured priority, and acceptance criteria in the description.

Dry-runs must work without credentials.

## Transition and link guardrails

Transitions and issue links are project-specific. The adapter may only perform them live after discovery confirms the exact transition ID/name or link type for the target ticket/project.

If discovery is unavailable or no exact match exists, the adapter emits fallback text:

```md
## Jira fallback: <operation>
Reason: <why live operation was not run>
Target: <ticket key or new issue>
Payload:
```json
{ ...exact Jira REST-style payload... }
```
Human action:
<one concise instruction>
```

This no-guessing rule keeps workflow changes safe while still giving a human an exact payload to apply.

## Dry-run examples

```bash
npm run jira:dry-run
npx tsx src/cli.ts jira render ../.omp/plans/oh-my-copilot-general-skills-ralplan-handoff.md
```

Expected dry-run evidence includes create/comment/safe-update support and transition/link discovery fallback state.
