# Subagent Prompt Templates

Use these templates when spawning `explore` agents via the `task` tool. Only used for **medium** and **large** research tasks.

## Agent roles

### Locator — find WHERE files and components live

```
Find all files and components related to [topic] in the codebase.
Return file paths, directory structure, and a brief note on what each file contains.
Do not evaluate or suggest improvements — only document what exists.
```

### Analyser — understand HOW specific code works

```
Read and document how [component] works.
Describe the data flow, key functions, and how it connects to other components.
Include file paths and line numbers.
Do not critique or suggest improvements — only describe what exists.
```

### Pattern finder — find examples of existing patterns

```
Find all examples of [pattern] across the codebase.
List each occurrence with file path, line number, and a brief description of how it's used.
Do not evaluate consistency or suggest changes — only document occurrences.
```

## Guidelines

- Each agent is stateless — provide complete context in the prompt
- Remind every agent: "You are documenting, not evaluating"
- Run independent explorations in parallel
- For web research (only if user explicitly asks), use a `research` agent instead of `explore`
- **Wait for ALL agents to complete before synthesising**
