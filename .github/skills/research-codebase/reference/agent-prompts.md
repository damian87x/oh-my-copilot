# Worker Prompt Templates

Use these templates when delegating research areas to parallel `omp team` workers. Only needed for **large** research tasks; for small/medium, run these roles directly in the main agent with glob/grep/read.

## Worker roles

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

- Each worker is stateless — provide complete context in the prompt
- Remind every worker: "You are documenting, not evaluating"
- Run independent explorations in parallel across team panes
- For web research (only if user explicitly asks), do it in the main agent
- **Collect all worker outputs before synthesising**
