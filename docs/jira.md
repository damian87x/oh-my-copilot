# Jira MVP Adapter

The Jira adapter prepares safe REST payloads and reports whether configuration is complete.

## Configuration

Use environment or repo `.env` variables:

- `JIRA_SITE_URL` or `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_PROJECT_KEY`

Secrets must remain in environment/configuration and must not be written into generated skills, wrappers, docs, or committed files.

## Supported MVP operations

- Create issue payload.
- Add comment payload.
- Safe field update payload.

Transitions and issue links require discovery of valid transition IDs and link types before applying. Until discovery is available, the adapter emits fallback payloads that preserve intent without pretending the operation is safe to apply.
