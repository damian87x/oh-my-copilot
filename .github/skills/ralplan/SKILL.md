---
name: ralplan
description: Produce an implementation-ready plan with risks, acceptance criteria, and test shape, reviewed by architect and critic subagents until consensus. Use with /ralplan when edits need planning first.
---

# Ralplan

Use `/ralplan` when the task needs planning before edits.

By default, ralplan is a **consensus workflow**: the draft plan is reviewed by the `architect`
subagent and then the `critic` subagent, and the plan is revised until the critic approves it.
Only skip the review loop when the user explicitly asks for a quick, unreviewed plan.

## When to use

- The change touches multiple files or components
- There are unclear trade-offs or risks
- You need alignment before implementation

## Steps

1. **Summarise** the target result and constraints in 2–3 sentences
2. **List implementation slices** in execution order — each slice should be independently verifiable
3. **Define acceptance criteria** — what must be true when done
4. **Define test shape** — which tests to write or run, what they cover
5. **Call out risks** — what could go wrong, tradeoffs chosen, alternatives rejected. For any
   auth, security, or data-handling feature, the plan **must** name the security specifics even
   if the request didn't: secret/token **expiry**, **single-use / replay** protection, and
   **enumeration / rate-limiting**. Leaving these implicit is how the plan ships a hole.
6. **Architect review** (default): write the full task statement and the draft plan to a temp
   file, then run the `architect` agent headlessly on it and capture the output:

   ```bash
   copilot -p "$(cat /tmp/ralplan-context.md)

   Review the plan above as the architect. Return your findings." \
     --agent architect --allow-all-tools | tee /tmp/ralplan-architect.md
   ```

   It must return a steelman antithesis, at least one real tradeoff tension, and a soundness
   check of anything load-bearing. **Wait for this run to finish before step 7.**
7. **Critic review** (default): run the `critic` agent the same way, feeding it the task
   statement, the draft plan, and the architect output from step 6:

   ```bash
   copilot -p "$(cat /tmp/ralplan-context.md)

   Architect review:
   $(cat /tmp/ralplan-architect.md)

   Decide whether this plan is actionable." \
     --agent critic --allow-all-tools | tee /tmp/ralplan-critic.md
   ```

   It must verify every referenced file, check that acceptance criteria are testable, and return
   **OKAY** or **REJECT** with concrete fixes.
8. **Re-review loop** (max 3 iterations): on any non-OKAY critic verdict, **you** (the main
   session) revise the plan using the architect and critic feedback, then repeat steps 6–7. If 3
   iterations pass without **OKAY**, present the best version to the user and call out the
   unresolved objections.
9. **Stop at the plan** unless the user explicitly asked to implement

> **Important:** Steps 6 and 7 are **two separate `copilot --agent` runs, in order** — architect
> first, then critic with the architect's output in hand. Never merge them into one run or ask a
> single agent to play both roles; only a completed `critic` **OKAY** satisfies the consensus gate.
> (If the `copilot` binary isn't on PATH, the agents can't run — tell the user rather than
> skipping the gate.)

## Output

- `Plan` — ordered implementation slices with file-level specificity
- `Tests` — acceptance criteria and test shape for each slice
- `Risks` — tradeoffs, concerns, and what was deliberately not done
- `Review` — the architect's findings and the critic's verdict (default loop only)
- `Ready for` — recommended next skill: `/team`, `/ralph`, `/ultrawork`, or direct edit
