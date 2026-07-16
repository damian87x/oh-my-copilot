---
name: wayfinder
description: Plan work too big for one agent session as a shared map of decision tickets on GitHub Issues or Jira, then resolve them one at a time until the route is clear. Use with /wayfinder when the user says "plan something too big for one session", "chart a map", "wayfind", "work the map", or "decision tickets". Always confirm tracker (GitHub vs Jira) and destination before writing. Adapted from mattpocock/skills wayfinder (MIT).
argument-hint: "[map-url-or-key] [ticket]"
---

# Wayfinder

A loose idea is too big for one agent session and wrapped in fog. Wayfinding charts the way as a **shared map** on an issue tracker, then works **decision tickets** — questions whose resolution is a decision, not a build slice — one at a time until the route is clear.

Name the **destination** first (spec, locked decision, or in-place change). It fixes scope for every ticket.

## Confirm tracker destination first

**Never create, edit, label, assign, transition, or close tickets until the human confirms both:**

1. **Tracker surface** — `github` or `jira` (not both for one map).
2. **Destination pin** — GitHub `owner/repo`, or Jira `project key` (+ site if ambiguous).

Wrong surface or wrong pin wastes real tickets (monorepo GitHub remote ≠ app repo; Jira project ≠ GitHub Issues).

### How to confirm (one question at a time)

1. Detect candidates only as **hints** (never auto-write):
   - GitHub: `git remote -v` (cwd + nested app roots named by the idea).
   - Jira: `JIRA_PROJECT_KEY` / `JIRA_BASE_URL` in env or project config; prior map Notes.
2. **Ask tracker first** if not already explicit in the user message or a full issue URL:
   - Recommend `github` or `jira` with a one-line reason.
   - Wait for an explicit answer.
3. **Ask pin second** for that surface:
   - GitHub: which `owner/repo`? Recommend best guess + reason (monorepo root vs nested app remote).
   - Jira: which **project key** (and base URL if multiple sites)? Recommend from config if present.
4. Pin the session:
   - GitHub → every `gh` call uses `-R owner/repo` (or `GH_REPO`). Ops: [references/tracker-github.md](references/tracker-github.md).
   - Jira → use `omp jira` / `/jira-ticket` with confirmed project; live writes only after user confirms. Ops: [references/tracker-jira.md](references/tracker-jira.md).
5. **Working** a map: full GitHub/Jira URL already implies surface + pin — use it; do not re-ask. Bare number/key only → ask surface + pin.
6. Record in map `## Notes`: `tracker: github|jira` and `pin: owner/repo` or `pin: PROJECTKEY`.

If the human changes mind mid-chart, **stop** — do not migrate silently; ask whether to abandon partial creates.

## Plan, don't do

Wayfinder is **planning** by default: produce decisions, not deliverables. Override only if the map's **Notes** say execution is in-map.

## Refer by name

In everything the human reads, refer to tickets by **title** (wrap the link in the name). Never bare `#42` / `PROJ-12` walls without names.

## The map

One issue/ticket labelled as the map (`wayfinder:map` on GitHub, `wayfinder-map` on Jira). It is an **index, not a store**. Open tickets are **not** listed in the body — found by query.

```markdown
## Destination

<what done planning looks like — one or two lines>

## Notes

tracker: github|jira
pin: owner/repo or PROJECTKEY
<domain; skills every session should consult; standing preferences>

## Decisions so far

- [<closed ticket title>](link) — <one-line gist>

## Not yet specified

## Out of scope
```

### Tickets

Child of the map. Body holds one question sized to one ~100K-token session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

Type labels: `research` | `prototype` | `grilling` | `task` (GitHub: `wayfinder:<type>`; Jira: `wayfinder-<type>`).

**Claim** first: assign to yourself before any work. Assignee = claim.

**Blocking** uses the tracker's native dependency/link where available; else body fallback. **Frontier** = open, unblocked, unclaimed children. **Never resolve more than one ticket per session** (exception: research tickets in parallel).

Assets link from the ticket — never paste large blobs in.

## Ticket types

**HITL** (live human; agent never answers for them) or **AFK** (agent alone).

- **Research** (AFK): primary sources via background worker; findings on `research/<slug>`; comment pointer. Not `/research-codebase` unless sources are local.
- **Prototype** (HITL): `/prototype`; link asset.
- **Grilling** (HITL): multi-question interview rules below (default). Not single-shot `/grill-me` for charting.
- **Task** (HITL or AFK): manual work that unblocks a decision.

## Fog of war

Sharp question → ticket (even if blocked). Not sharp → `## Not yet specified`. Resolving tickets graduates fog.

## Out of scope

Past the destination: **close** and one line in `## Out of scope`. Never in Decisions-so-far.

## Interview rules (charting + grilling)

One question at a time; recommend an answer; look up facts yourself; **decisions belong to the human**. Breadth-first when mapping the frontier.

## Invocation

### Chart the map (loose idea → map)

1. **Confirm tracker + pin** — hard stop until the human answers both.
2. **Name the destination** via interview rules.
3. **Map the frontier** breadth-first. If no fog — don't build a map; ask how to proceed.
4. **Create the map** on the confirmed tracker/pin; Notes include `tracker` + `pin`.
5. **Create tickets**, then wire blocking/links in a **second pass**.
6. **Fire research workers** in parallel for research tickets.
7. **Stop** — charting resolves nothing itself.

### Work through the map (map URL/key; ticket optional)

1. Surface + pin from URL, or ask if bare id only.
2. Load **map body only**.
3. User-named ticket or first frontier ticket. **Claim first**.
4. Resolve; zoom related bodies; invoke skills in `## Notes`.
5. Resolution comment → close/done → append Decisions-so-far line.
6. Create/graduate/invalidate as the answer dictates.

## References

- GitHub: [references/tracker-github.md](references/tracker-github.md)
- Jira: [references/tracker-jira.md](references/tracker-jira.md)
