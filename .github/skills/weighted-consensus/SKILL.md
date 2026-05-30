---
name: weighted-consensus
description: Multi-model council — fan a question out to several models in parallel, then synthesize one weighted verdict with a minority report. Use with /weighted-consensus to decide, review, or compare options across diverse models.
argument-hint: "<question> [--models a,b,c] [--context @file]"
---

# Weighted Consensus — multi-model council

`/weighted-consensus` runs an independent **model council**: it asks the same
question to several models in parallel (each with its own role), then a separate
synthesizer model reasons over their answers — using each member's weight as a
**prior**, not a vote tally — to produce one final verdict plus a minority report.

## When to use

- You want a higher-confidence decision than a single model gives
- Reviewing a change, comparing approaches, or making an architecture call
- You want dissent surfaced instead of averaged away

## How it works

1. **Fan-out** — each member runs as an independent `copilot --model <X>` process
   (parallel, capped concurrency). Members never see each other's answers.
2. **Structured output** — each member returns JSON wrapped in `<<<JSON>>> … <<<END>>>`
   sentinels: `verdict`, `confidence`, `rationale`, optional `risks`/`dissent`.
3. **Synthesis** — a low-context synthesizer model merges survivors into a final
   `verdict`, `confidence`, `rationale`, and `minority_report`. Evidence quality
   can override weight.
4. **Graceful degradation** — timed-out, errored, unavailable, or unparseable
   members are dropped; the council still synthesizes from the rest, and only
   fails if fewer than `min-survivors` (default 2) remain.

## Agent execution steps (FOLLOW EXACTLY)

When `/weighted-consensus` is invoked, you (the agent) MUST:

### Step 1 — Build the question

Take the user's text as the `<question>`. If they referenced a file, a diff, or
prior conversation, capture it as shared context (write it to a temp file and pass
`--context @<file>` so large context isn't mangled on the command line).

### Step 2 — Run the council command

Run the engine via the shell. It manages the parallel model calls, parsing,
degradation, and synthesis for you — do NOT try to call models yourself:

```
omp council "<question>" [--models a,b,c | model:role:weight,...] \
  [--context <text|@file>] [--rubric <text|@file>] \
  [--synth <model>] [--probe] [--timeout <ms>] \
  [--min-survivors <n>] [--max-concurrency <n>] [--tmp-dir <dir>] [--json]
```

- `--models` — inline roster override. Bare tokens (`a,b,c`) get round-robin
  default roles (critic, architect, pragmatist); long-form `model:role:weight`
  sets all three. If omitted, the default roster from `.omp/config.json` (or the
  built-in default) is used.
- `--context @file` / `--rubric @file` — read context or an evaluation rubric
  from a file (prefer this over inline for anything multi-line).
- `--probe` — opt-in preflight that prunes models your plan cannot access (off by
  default; the normal run already reports unavailable models inline).
- `--json` — emit the full structured result for programmatic use; omit it for a
  readable verdict + dropped-member summary.

If `omp council` is not found (the published `omp` predates this feature), fall
back to the local build from the repo root: `node dist/src/cli.js council "<question>" ...`
(run `npm run build` first if `dist/` is stale).

### Step 3 — Present the result

Report the synthesizer's `verdict`, `confidence`, and `rationale`, then ALWAYS
surface the `minority_report` if non-empty (it exists to stop dangerous edge cases
being voted away). Note any dropped members and why. Point to the artifacts dir
for the raw per-member JSON if the user wants to inspect individual answers.

### Example invocations

```
/weighted-consensus "Should this service use gRPC or REST?"
/weighted-consensus "Is this migration safe to ship?" --models gpt-5-mini,gpt-4.1
/weighted-consensus "Review the staged diff for blockers" --context @/tmp/diff.txt --rubric @/tmp/rubric.md
```

## Configuration

The default roster and synthesizer live in `.omp/config.json` under a `council`
block; inline `--models` overrides it. If no config is present, a built-in
default roster is used.

```json
{
  "council": {
    "synthesizer": "gpt-4.1",
    "minSurvivors": 2,
    "maxConcurrency": 4,
    "probe": false,
    "members": [
      { "model": "gpt-5-mini", "role": "critic", "weight": 0.4 },
      { "model": "gpt-4.1", "role": "architect", "weight": 0.35 },
      { "model": "gpt-5-mini", "role": "pragmatist", "weight": 0.25 }
    ]
  }
}
```

## Notes

- Diversity comes from the **model mix and per-role prompts** — the Copilot CLI
  headless surface exposes no temperature/sampling control.
- Per-member JSON artifacts are written under a temp directory for debugging and
  are not auto-cleaned.
- For genuine independence, prefer distinct models. If your plan only includes
  the free GPT tier (e.g. `gpt-5-mini`, `gpt-4.1`), distinct ROLES still add
  diversity; add a different-provider model (e.g. a Claude model) if available.

## Composition

Pair with `/code-review` (pass a review rubric + the diff as context) for a
multi-model review verdict, or with `/ralplan` to weigh competing plans.
