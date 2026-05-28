---
name: prototype
description: Build a disposable experiment to answer one design, UI, state, or data-model question. Use with /prototype when a cheap experiment beats guessing.
---

# Prototype

Use `/prototype` when a cheap experiment beats guessing.

## When to use

- You're unsure about a design choice and need to try it
- A UI layout, state shape, or API contract is unclear
- "Let me try it" is faster than "let me think about it"

## Steps

1. **State the question** — what are you trying to learn? (e.g. "Does a tree or flat list work better for this state?")
2. **Build the smallest throwaway version** — prefer:
   - Isolated routes or pages
   - Hardcoded fixtures instead of real data
   - Terminal demos for backend logic
   - Standalone scripts for API experiments
3. **Mark as disposable** — prefix files with `prototype-` or put in a `prototype/` directory
4. **Run it** — actually test the prototype, don't just write it
5. **Decide** — keep (graduate to real code), revise (iterate), or discard (delete)

## Rules

- Prototypes are not production code — speed over polish
- Delete prototypes that aren't kept — don't let them linger
- One question per prototype — don't scope-creep

## Output

- `Question` — what was being tested
- `Prototype` — what was built and where
- `What we learned` — concrete findings
- `Decision` — keep, revise, or discard
