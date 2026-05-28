# Research Document Template

Use this template for all research documents written to `docs/research/`.

## Filename convention

- With ticket: `YYYY-MM-DD-PROJ-1234-description.md`
- Without ticket: `YYYY-MM-DD-description.md`

## Frontmatter

```yaml
---
date: [ISO datetime with timezone from git/system]
researcher: [git user.name]
git_commit: [commit hash]
branch: [branch name]
repository: [repo name]
topic: "[User's question/topic]"
tags: [research, codebase, relevant-component-names]
status: complete
last_updated: [YYYY-MM-DD]
last_updated_by: [git user.name]
---
```

## Gather metadata

Run these commands — never write placeholder values:

```bash
echo "date: $(date -u +%Y-%m-%dT%H:%M:%S%z)"
echo "user: $(git config user.name)"
echo "commit: $(git rev-parse HEAD)"
echo "branch: $(git branch --show-current)"
echo "repo: $(basename $(git rev-parse --show-toplevel))"
```

## Document structure

```markdown
# Research: [User's Question/Topic]

**Date**: [datetime]
**Researcher**: [name]
**Git Commit**: [hash]
**Branch**: [branch]
**Repository**: [repo]

## Research Question
[Original user query]

## Summary
[High-level documentation of what was found — describe what exists]

## Detailed Findings

### [Component/Area 1]
- Description of what exists (`file.ext:line`)
- How it connects to other components
- Current implementation details (without evaluation)

### [Component/Area 2]
...

## Code References
- `path/to/file.py:123` — Description of what's there
- `another/file.ts:45-67` — Description of the code block

## Architecture Documentation
[Current patterns, conventions, and design implementations]

## Open Questions
[Areas that need further investigation]
```
