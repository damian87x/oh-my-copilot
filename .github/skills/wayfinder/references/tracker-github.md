# Issue tracker: GitHub (wayfinder operations)

Use only after the human confirms **tracker = github** and **`owner/repo`** (see SKILL.md "Confirm tracker destination first"). Do not open Jira tickets as a fallback.

Issues live as GitHub issues. Use the `gh` CLI for all operations.

## Repo pin (required)

**Do not rely on cwd alone.** Monorepos and nested app remotes often differ from the path the map is about.

1. Before any write, the skill must have a human-confirmed `owner/repo`.
2. Set for the session and pass on every command:

```bash
export GH_REPO=owner/repo   # optional convenience
# Prefer explicit -R on every call:
gh -R owner/repo issue create ...
gh api repos/owner/repo/issues/...
```

3. Detect candidates with `git remote -v` in cwd and in nested project roots named by the destination — then **ask**, don't auto-pick when more than one remote or a monorepo root is involved.
4. Put `tracker: github` and `pin: owner/repo` in the map `## Notes` (same keys as SKILL.md — never put the repo slug in `tracker:`).

## Labels

Create idempotently on first charting:

```bash
for l in wayfinder:map wayfinder:research wayfinder:prototype wayfinder:grilling wayfinder:task; do
  gh -R owner/repo label create "$l" --force 2>/dev/null || true
done
```

## Map

```bash
gh -R owner/repo issue create --label wayfinder:map --title "..." --body "$(cat <<'EOF'
## Destination
...
## Notes
tracker: github
pin: owner/repo
...
## Decisions so far
## Not yet specified
## Out of scope
EOF
)"
```

Open tickets stay off the map body when sub-issues work. The task-list fallback below **intentionally** lists children in the body when sub-issues are unavailable.

## Child ticket (sub-issue)

1. Create the issue with label `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`).
2. Link as a GitHub sub-issue of the map:

```bash
CHILD_DB_ID=$(gh api "repos/owner/repo/issues/<child-n>" --jq .id)
# sub_issue_id must be a JSON integer — -F/-f send strings.
gh api --method POST "repos/owner/repo/issues/<map-n>/sub_issues" \
  --input - <<< "{\"sub_issue_id\": ${CHILD_DB_ID}}"
```

**Fallback** if sub-issues unavailable: add a task-list entry in the map body and put `Part of #<map>` at the top of the child body.

List children: `gh api "repos/owner/repo/issues/<map-n>/sub_issues"`.

## Blocking (native issue dependencies)

Wire edges in a **second pass** after all tickets exist (ids required first).

```bash
BLOCKER_DB_ID=$(gh api "repos/owner/repo/issues/<blocker-n>" --jq .id)
# issue_id must be a JSON integer — -F/-f send strings and 422.
gh api --method POST "repos/owner/repo/issues/<child-n>/dependencies/blocked_by" \
  --input - <<< "{\"issue_id\": ${BLOCKER_DB_ID}}"
```

Use the blocker's numeric **database id** (`.id`), not the `#number` or `node_id`.

**Authoritative check** — list open blockers (preferred; summary on issue GET can lag ~1–2s after write):

```bash
gh api "repos/owner/repo/issues/<child-n>/dependencies/blocked_by" \
  --jq '[.[] | select(.state=="open")] | length'
```

`issue_dependencies_summary.blocked_by` counts **open** blockers only; `total_blocked_by` includes closed. Unblocked when open count is `0`.

**Fallback** if dependencies unavailable: `Blocked by: #n, #n` line at the top of the child body.

## Frontier query

1. List the map's open children (sub-issues API, or task-list fallback).
2. Drop any with open blockers (blocked_by list length > 0, or an open issue in the `Blocked by` line).
3. Drop any with an assignee (claimed).
4. First remaining in map order wins.

## Claim

Session's **first write**, before any work:

```bash
gh -R owner/repo issue edit <n> --add-assignee @me
```

Assignee = claim. Concurrent sessions skip claimed tickets.

## Resolve

1. `gh -R owner/repo issue comment <n> --body "<answer>"`
2. `gh -R owner/repo issue close <n>`
3. Append one line to the map's `## Decisions so far`:

```markdown
- [<title>](<url>) — <one-line gist>
```

Re-fetch the map body immediately before `gh -R owner/repo issue edit <map> --body ...` (read-modify-write; expect concurrent editors).

## General `gh` ops

Always include `-R owner/repo` (or `GH_REPO`).

- Read: `gh -R owner/repo issue view <n> --comments`
- List: `gh -R owner/repo issue list --state open --label wayfinder:map --json number,title,labels,assignees`
- Labels: `gh -R owner/repo issue edit <n> --add-label "..."` / `--remove-label "..."`
