# Learning Record Format

Lives in `learning-records/`, numbered `0001-slug.md`, `0002-slug.md`. Create the dir lazily.

The teaching equivalent of ADRs: non-obvious lessons, key insights, stated prior knowledge that steer future sessions. Used to calculate the zone of proximal development.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

That is the whole format. One paragraph is fine. Value = recording *that* this is known and *why* it changes what to teach next.

## Optional sections (only when they add value)

- **Status** frontmatter (`active | superseded by LR-NNNN`) — when an earlier understanding is replaced.
- **Evidence** — how the user demonstrated it (question answered, exercise done, prior experience). When the claim may be revisited.
- **Implications** — what this unlocks or rules out. When non-obvious.

## Numbering

Scan `learning-records/` for the highest number, increment by one.

## When to write one

- User demonstrated genuine understanding of something non-trivial (evidence, not just exposure). Sets a new floor.
- User disclosed prior knowledge ("I already know X"). Record it + the depth claimed.
- A misconception was corrected. High-value — predicts future stumbling blocks.
- The mission shifted from learning. Cross-link MISSION.md and update it.

## Does NOT qualify

- Material merely covered. Coverage is not learning — wait for evidence.
- Anything already in GLOSSARY.md. Don't duplicate.
- Session activity logs. Records are decision-grade insights, not a journal.

## Supersession

When a later record contradicts an earlier one, mark the old `Status: superseded by LR-NNNN` — don't delete. The evolution of understanding is signal.
