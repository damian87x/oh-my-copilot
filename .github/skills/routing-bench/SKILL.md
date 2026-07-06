---
name: routing-bench
description: Build or refresh the skill-routing benchmark dataset and score routing accuracy. Prefers real usage history; on a new install with no history it derives prompts from a repository's skills and asks the user which source to use. Use with /routing-bench to measure or improve how well prompts route to the right skill. Not for reviewing code changes — use /code-review; not for verifying a finished task — use /verify.
---

# Routing Bench

Use `/routing-bench` to build, extend, or re-score the skill-routing benchmark
(`benchmarks/skill-bench/routing/dataset.json` + `test/routing-bench.test.ts`).

## When to use

- After adding, renaming, or rewording a skill (descriptions are the routing surface)
- After changing `omp suggest` rules in `src/commands/suggest.ts`
- When routing feels wrong ("it picked the wrong skill") and you want evidence
- On a schedule, to catch routing drift as skills accumulate

## Source selection (flexible — this is the core of the skill)

Prompts must come from somewhere. Check sources in this order and **tell the
user which one you picked**:

1. **Real usage history** (best): user prompts from `~/.copilot/session-store.db`
   (`turns.user_message`) or project logs (e.g. `.omp/`, daily-log files).
   Use it when it has enough volume (roughly 30+ distinct prompts).
2. **Repository-derived** (fallback for new installs with no history): generate
   prompts from a repository's skill definitions — frontmatter descriptions,
   "When to use" sections, README examples, and `suggest.ts` rule signals.
3. **Hand-written** (always allowed): keep and never overwrite manually
   authored cases already in the dataset.

**If no history exists, ask the user which repository to derive from** — do not
assume. The skills being benchmarked may live in this repo, an installed plugin
(`~/.copilot/skills/`), or the user's target project (`.github/skills/` there).
One question, concrete options, e.g.:

> No usage history found. Which repository should I derive routing prompts
> from? (a) this repo's `.github/skills/`, (b) installed user skills at
> `~/.copilot/skills/`, (c) another repo — give me a path.

If more than one source is viable (some history + new undocumented skills),
propose a mix and let the user confirm.

## Steps

1. **Pick the source** per the rules above; state the choice and why.
2. **Generate cases** — for each skill, aim for 3 labeled prompts:
   `direct` (obvious phrasing), `paraphrase` (no signature keywords),
   `ambiguous` (plausibly matches a sibling skill). Add `none` cases for
   prompts no skill should claim. From history: cluster real prompts by which
   skill actually handled them and pick representative ones. From repository:
   write realistic prompts a user would type, not copies of the description.
3. **Merge, don't clobber** — append to `dataset.json`, keep existing case
   `id`s stable, dedupe near-identical prompts.
4. **Score** — `npx vitest run test/routing-bench.test.ts`. Report accuracy
   and the miss list.
5. **Ratchet** — if accuracy improved because rules/descriptions improved,
   raise the thresholds in `test/routing-bench.test.ts`. Never lower them;
   if new hard cases drop accuracy below the gate, fix routing (descriptions
   or `suggest.ts` rules) instead of deleting cases.

## Rules

- Real history outranks synthetic prompts; synthetic outranks nothing.
- Never put secrets, names, or private paths from history into the dataset —
  paraphrase real prompts if they contain anything sensitive.
- Every case needs `id`, `kind`, `expected`, `prompt`.
- Confusion-cluster prompts (see `docs/sweep-report.md`) are the most valuable
  cases — prefer adding those over easy direct hits.

## Output

- `Source used` — history / repository-derived / mixed, and why
- `Cases added` — count per skill and kind
- `Accuracy` — in-workflow % and top-1 % before → after
- `Misses` — worst confusions, with the routing fix they suggest
