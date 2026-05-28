---
name: research-codebase
description: Comprehensive codebase research that scales effort to task complexity, synthesises findings, and writes a timestamped document to docs/research/. Use when user says /research-codebase, asks to research or document a codebase area, or wants a deep-dive into how something works.
---

# Research Codebase

Read-only codebase research. Documents what EXISTS — no recommendations or critiques unless explicitly asked.

## Contract (stated once)

- ONLY describe what exists, where it exists, how it works, and how components interact
- Do NOT suggest improvements, critique implementation, or propose changes
- You are creating a technical map of the existing system

## When invoked without a query

Respond: "I'm ready to research the codebase. What area or question should I investigate?" — then wait.

## Steps

### 1. Read mentioned files

If the user references specific files, read them with `view` in the **main context** before anything else.

### 2. Scope the tech stack

Detect from `package.json`, config files, directory structure, and project conventions. This determines which reference files are relevant — do NOT load unrelated framework guidance.

### 3. Size the task → choose effort tier

| Tier | When | Agent strategy |
|------|------|----------------|
| **Small** | Single file/component, narrow question | Main agent reads directly. No subagents. |
| **Medium** | Cross-file, single area (e.g. "how does auth work") | 1–2 `explore` agents for locate + analyse |
| **Large** | Cross-cutting, multi-area (e.g. "map the entire API layer") | Parallel locator → analyser → pattern-finder (see `reference/agent-prompts.md`) |

### 4. Research

- Track subtasks via SQL `todos` table
- For medium/large: read `reference/agent-prompts.md` for subagent prompt templates
- **MUST GATE**: Before writing findings, show file:line evidence for every claim

### 5. Synthesise & write document

- Read `reference/template.md` for output format and frontmatter
- Read `reference/permalink.md` if GitHub permalinks are applicable
- Gather git metadata: `date`, `user`, `commit`, `branch`, `repo`
- Write to `docs/research/YYYY-MM-DD-description.md`

### 6. Present findings

Show concise summary to user with key file references. Ask if they have follow-up questions.

### 7. Follow-ups

If the user has follow-ups, read `reference/follow-up.md` for the append protocol.
